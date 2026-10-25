'use strict';
/* Version A (no Redis): make sure nothing can silently depend on a Redis server. */
delete process.env.REDIS_URL;
