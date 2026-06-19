# SCALE.md — 10k RPS Design

## Data Model / Indexes
- `signals` table with `id`, `user_id`, `type`, `payload`, `idempotency_key`, `created_at`
- Index on `(user_id, created_at)` for fast paginated LIST queries
- UNIQUE index on `idempotency_key` — enforces deduplication at DB level, survives concurrent inserts
- Partition table by `created_at` (monthly) if data grows beyond 100M rows

## Idempotency Across Instances
- DB UNIQUE constraint on `idempotency_key` is the source of truth — prevents duplicate rows even under concurrent requests hitting different instances
- Add Redis cache (TTL 24h) to short-circuit DB lookup: check Redis first, only hit DB on miss
- On insert conflict (UNIQUE violation), catch the error and return the existing row — no duplicate created

## Rate Limiting Across Instances
- Current in-memory Map only works for single instance
- At scale: Redis sorted sets per userId — ZADD + ZREMRANGEBYSCORE + ZCARD in a single Lua script (atomic, no race)
- Alternatively: Redis INCR + EXPIRE with a 60s TTL key per `userId:minute_bucket`
- Redis cluster with replication ensures no single point of failure

## Observability (Logs / Metrics / Alerts)
- Structured JSON logs via Fastify logger — ship to Datadog / CloudWatch / ELK
- Metrics to track: p50/p95/p99 latency, error rate (4xx/5xx), rate limit hits per userId, DB retry count, idempotency cache hit rate
- Alerts: error rate > 1%, p99 > 500ms, DB connection pool exhausted, Redis latency spike
- Distributed tracing: add trace IDs per request via OpenTelemetry to correlate across services

## Failure Modes
- **DB down**: retry with exponential backoff + jitter (3 retries, base 100ms) — already implemented. After retries exhausted, return 503
- **Circuit breaker**: open after N consecutive failures to stop hammering a recovering DB
- **Partial DB outage**: read replicas serve GET requests; writes fail fast and return 503
- **Redis down**: fall back to in-memory rate limiting per instance (degraded but functional). Idempotency falls back to DB-only path
- **Duplicate on retry**: UNIQUE constraint on `idempotency_key` catches concurrent inserts — conflict error caught and existing row returned safely

## 10k RPS Design Sketch

### Request Flow
    Client
       ↓
    AWS ALB (load balancer)
       ↓
    Fastify instances x4 (stateless, autoscaled)
       ↓
    Redis Cluster (rate limit check ~1ms + idempotency cache ~1ms)
       ↓
    PostgreSQL RDS Primary (writes, ~5ms pooled)
       ↓
    PostgreSQL Read Replica (reads/GET queries)

### Infra Components
- 4 to 8 Fastify instances (Node.js, 2 vCPU each) behind AWS ALB
- PostgreSQL RDS db.r6g.2xlarge with 1 read replica, connection pool max 20 per instance
- Redis cluster cache.r6g.large (2 nodes) for rate limiting and idempotency cache
- SQS queue in front of DB writes to absorb burst spikes beyond 10k RPS if needed

### Cost Ballpark (AWS us-east-1)
- 4x EC2 c6g.large for Fastify: ~$200/mo
- RDS db.r6g.2xlarge + 1 read replica: ~$600/mo
- Redis cache.r6g.large cluster: ~$150/mo
- ALB + data transfer: ~$50/mo
- Total estimated cost: ~$1,000/mo for 10k sustained RPS
