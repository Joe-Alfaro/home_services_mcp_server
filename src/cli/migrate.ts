import pg from 'pg'
import { loadConfig } from '../config.ts'
import { migrate } from '../db/migrate.ts'

const client = new pg.Client({ connectionString: loadConfig().databaseUrl })
await client.connect()
try {
  const applied = await migrate(client)
  console.log(
    applied.length === 0 ? 'migrate: up to date' : `migrate: applied ${applied.join(', ')}`,
  )
} finally {
  await client.end()
}
