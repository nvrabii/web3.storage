/* global BRANCH, VERSION, COMMITHASH, SENTRY_RELEASE */
import Toucan from 'toucan-js'
import { S3Client } from '@aws-sdk/client-s3/dist-es/S3Client.js'
import { Magic } from '@magic-sdk/admin'
import { DBClient } from '@web3-storage/db'
import { Cluster } from '@nftstorage/ipfs-cluster'
import { DEFAULT_MODE } from './maintenance.js'
import { Logging } from './utils/logs.js'
import pkg from '../package.json'
import { magicTestModeIsEnabledFromEnv } from './utils/env.js'
import { defaultBypassMagicLinkVariableName } from './magic.link.js'

/**
 * @typedef {object} Env
 * // Environment and global vars
 * @property {string} DEBUG
 * @property {string} ENV
 * @property {string} BRANCH
 * @property {string} VERSION
 * @property {string} COMMITHASH
 * @property {string} SALT
 * @property {string} MAGIC_SECRET_KEY
 * @property {string} CLUSTER_API_URL
 * @property {string} [CLUSTER_BASIC_AUTH_TOKEN]
 * @property {string} PG_REST_URL
 * @property {string} PG_REST_JWT
 * @property {string} GATEWAY_URL
 * @property {string} [S3_BUCKET_ENDPOINT]
 * @property {string} S3_BUCKET_NAME
 * @property {string} S3_BUCKET_REGION
 * @property {string} S3_ACCESS_KEY_ID
 * @property {string} S3_SECRET_ACCESS_KEY_ID
 * @property {string} [SENTRY_DSN]
 * @property {string} [SENTRY_RELEASE]
 * @property {string} [LOGTAIL_TOKEN]
 * @property {string} MAINTENANCE_MODE
 * @property {string} [DANGEROUSLY_BYPASS_MAGIC_AUTH]
 * // Derived values and class dependencies
 * @property {Cluster} cluster
 * @property {DBClient} db
 * @property {Logging} log
 * @property {Magic} magic
 * @property {Toucan} sentry
 * @property {import('./maintenance').Mode} MODE
 * @property {S3Client} s3Client
 * @property {string} s3BucketName
 * @property {string} s3BucketRegion
 * @property {string} mockStripePaymentMethodId
 */

/**
 * Modifies the given env object by adding other items to it, mostly things
 * which are configured from the initial env values.
 * @param {Request} req
 * @param {Env} env
 * @param {import('./index.js').Ctx} ctx
 */
export function envAll (req, env, ctx) {
  // In dev, set these vars in a .env file in the parent monorepo project root.
  if (!env.PG_REST_URL) {
    throw new Error('MISSING ENV. Please set PG_REST_URL')
  }
  // These values are replaced at build time by esbuild `define`
  // @ts-ignore
  env.BRANCH = BRANCH
  // @ts-ignore
  env.VERSION = VERSION
  // @ts-ignore
  env.COMMITHASH = COMMITHASH
  // @ts-ignore
  env.SENTRY_RELEASE = SENTRY_RELEASE

  // @ts-ignore
  env.sentry = env.SENTRY_DSN && new Toucan({
    dsn: env.SENTRY_DSN,
    context: ctx,
    request: req,
    allowedHeaders: ['user-agent', 'x-client'],
    allowedSearchParams: /(.*)/,
    debug: env.DEBUG === 'true',
    rewriteFrames: {
      // strip . from start of the filename ./worker.mjs as set by cloudflare, to make absolute path `/worker.mjs`
      iteratee: (frame) => ({ ...frame, filename: frame.filename?.substring(1) })
    },
    environment: env.ENV,
    release: env.SENTRY_RELEASE,
    pkg
  })

  // Attach a `Logging` instance, which provides methods for logging and writes
  // the logs to LogTail. This must be a new instance per request.
  // Note that we pass `ctx` as the `event` param here, because it's kind of both:
  // https://developers.cloudflare.com/workers/runtime-apis/fetch-event/#syntax-module-worker
  // @ts-ignore
  env.log = new Logging(req, ctx, {
    token: env.LOGTAIL_TOKEN,
    debug: env.DEBUG === 'true',
    sentry: env.sentry,
    version: env.VERSION,
    branch: env.BRANCH,
    commithash: env.COMMITHASH
  })

  env.magic = new Magic(env.MAGIC_SECRET_KEY, {
    // @ts-ignore
    testMode: magicTestModeIsEnabledFromEnv(env)
  })

  // We can remove this when magic admin sdk supports test mode
  if (new URL(req.url).origin === 'http://testing.web3.storage' && env[defaultBypassMagicLinkVariableName] !== 'undefined') {
    // only set this in test/scripts/worker-globals.js
    console.log(`!!! ${defaultBypassMagicLinkVariableName}=${env[defaultBypassMagicLinkVariableName]} !!!`)
  }

  env.db = new DBClient({
    endpoint: env.PG_REST_URL,
    token: env.PG_REST_JWT
  })

  // @ts-ignore
  env.MODE = env.MAINTENANCE_MODE || DEFAULT_MODE

  const clusterAuthToken = env.CLUSTER_BASIC_AUTH_TOKEN
  const headers = clusterAuthToken ? { Authorization: `Basic ${clusterAuthToken}` } : {}
  // @ts-ignore
  env.cluster = new Cluster(env.CLUSTER_API_URL, { headers })

  if (!env.S3_BUCKET_NAME) {
    throw new Error('MISSING ENV. Please set S3_BUCKET_NAME')
  } else if (!env.S3_BUCKET_REGION) {
    throw new Error('MISSING ENV. Please set S3_BUCKET_REGION')
  } else if (!env.S3_ACCESS_KEY_ID) {
    throw new Error('MISSING ENV. Please set S3_ACCESS_KEY_ID')
  } else if (!env.S3_SECRET_ACCESS_KEY_ID) {
    throw new Error('MISSING ENV. Please set S3_SECRET_ACCESS_KEY_ID')
  }

  env.s3BucketName = env.S3_BUCKET_NAME
  env.s3BucketRegion = env.S3_BUCKET_REGION

  // https://github.com/aws/aws-sdk-js-v3/issues/1941
  let endpoint
  if (env.S3_BUCKET_ENDPOINT) {
    const endpointUrl = new URL(env.S3_BUCKET_ENDPOINT)
    endpoint = { protocol: endpointUrl.protocol, hostname: endpointUrl.host }
  }

  env.s3Client = new S3Client({
    // logger: console, // use me to get some debug info on what the client is up to
    endpoint,
    forcePathStyle: !!env.S3_BUCKET_ENDPOINT, // Force path if endpoint provided
    region: env.S3_BUCKET_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY_ID
    }
  })
  if (env.ENV === 'dev') {
    // show me what s3 sdk is up to.
    env.s3Client.middlewareStack.add(
      (next, context) => async (args) => {
        console.log('s3 request headers', args.request.headers)
        return next(args)
      },
      {
        step: 'finalizeRequest'
      }
    )
  }

  // via https://stripe.com/docs/api/payment_methods/object
  // this can be used to mock realistic values of a stripe.com paymentMethod id
  // after fulls tripe integration, this may not be needed on the env
  env.mockStripePaymentMethodId = 'pm_1LZnQ1IfErzTm2rETa7IGoVm'
}
