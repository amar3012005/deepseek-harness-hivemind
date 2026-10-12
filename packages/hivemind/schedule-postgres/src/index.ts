/** Tenant ownership policy and PostgreSQL StorageBackend for native Schedule. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Pool } from 'pg'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { PostgresScheduleStorageBackend } from './storage-backend.ts'
import { PostgresScheduleOwnershipPolicy } from './ownership-policy.ts'

export const POSTGRES_SCHEDULE_BACKEND = 'hivemind-schedule-postgres'

/** Hosted PG storage and tenant-fence configuration. */
export interface Config {
  sharedOrganizationAgents?: boolean
  connectionStringEnv: string
  schema: string
  maxConnections?: number
  statementTimeoutMs?: number
  maxTasksPerUser?: number
}

export const Config: z<Config> = z.object({
  sharedOrganizationAgents: z.boolean().default(false),
  connectionStringEnv: z.string().required(),
  schema: z.string().required().pattern(/^[a-z_][a-z0-9_]*$/u),
  maxConnections: z.natural().min(1).default(4),
  statementTimeoutMs: z.natural().min(1000).default(15000),
  maxTasksPerUser: z.natural().min(1).max(10000).default(100),
})

/** Registers the hosted ownership policy and native Schedule storage medium. */
export default class HivemindScheduleOwnership extends Service {
  static inject = ['storage', 'hivemindExecutionScope']
  static Config = Config

  private readonly pool: Pool
  private readonly backend: PostgresScheduleStorageBackend
  private readonly policy: PostgresScheduleOwnershipPolicy

  constructor(ctx: Context, config: Config, testPool?: Pool) {
    // Reserve a distinct Cordis service name: `scheduleOwnership` is the typed
    // context service consumed by native Schedule and must refer to the policy.
    super(ctx, 'hivemindScheduleOwnership')
    const connectionString = process.env[config.connectionStringEnv]
    if (testPool === undefined && !connectionString) throw new Error('Schedule database URL is required')
    this.pool = testPool ?? new Pool({
      connectionString,
      max: config.maxConnections ?? 4,
      options: `-c search_path=${config.schema},public`,
    })
    const policyConfig = {
      sharedOrganizationAgents: config.sharedOrganizationAgents ?? false,
      statementTimeoutMs: config.statementTimeoutMs ?? 15000,
      maxTasksPerUser: config.maxTasksPerUser ?? 100,
    }
    this.policy = new PostgresScheduleOwnershipPolicy(ctx, this.pool, policyConfig)
    this.backend = new PostgresScheduleStorageBackend(this.pool, this.policy, policyConfig.statementTimeoutMs)
    ctx.provide('scheduleOwnership', this.policy)
    ctx.provide(storageBackendServiceKey(POSTGRES_SCHEDULE_BACKEND), this.backend)
    ctx.effect(() => {
      const unregister = ctx.storage.backend.register(POSTGRES_SCHEDULE_BACKEND, this.backend)
      return () => {
        unregister()
        return this.backend.close()
      }
    }, 'hivemindScheduleOwnership.registerStorage')
  }

  async [Service.init](): Promise<void> {
    try {
      await this.pool.query('SELECT id,session_id,record,status,last_delivery,delivery_history,org_id,user_id,actor_user_id,audience,revision FROM harness_scheduled_tasks LIMIT 0')
      await this.pool.query('SELECT task_id,org_id,user_id,actor_user_id,due_at FROM harness_scheduled_due LIMIT 0')
    } catch (error) {
      await this.pool.end()
      throw new Error('Schedule PostgreSQL schema is not migrated for the native storage provider', { cause: error })
    }
  }
}

export { PostgresScheduleStorageBackend, PostgresScheduleOwnershipPolicy }
