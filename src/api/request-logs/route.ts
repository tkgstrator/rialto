/**
 * Request-log API surface. Route handlers are grouped by concern under
 * this folder (sessions / session-detail / logs-crud / stats / sse), each
 * registering directly onto the shared instance from ./app; importing
 * them here for their side effects wires everything together.
 */

import { requestLogsRoute } from './app'
import './logs-crud'
import './session-detail'
import './sessions'
import './sse'
import './stats'

export { requestLogsRoute }
