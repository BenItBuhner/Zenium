import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.hourly('expire device links', { minuteUTC: 7 }, internal.links.expire, {})
crons.daily('purge revoked device sessions', { hourUTC: 4, minuteUTC: 17 }, internal.devices.purgeRevoked, {})

export default crons
