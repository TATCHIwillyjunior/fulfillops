# FulfillOps

FulfillOps is a lightweight fulfillment and order-processing system built as a DevOps lab project. It exposes an API for catalog lookup, stock validation, and order creation while tracking operational health, idempotency, and worker-based processing.

## Overview

The project is composed of:

- `api`: Express.js API service serving catalog and order endpoints
- `db`: PostgreSQL migration schema and seed data
- `worker`: background job processing layer
- `infra`: infrastructure and deployment assets
- `scripts`: operational tooling and automation scripts
- `tests`: automated checks and validation
- `docs`: architecture and incident documentation

## Main Features

- Catalog and inventory retrieval endpoints
- Atomic order creation with stock reservation
- Idempotency keys for safe retry behavior
- PostgreSQL-backed order and worker job tracking
- Health checks for liveness and readiness
- Prometheus metrics exposure for observability
- Docker Compose-based local environment setup

## Project Architecture

The application follows a simple service-oriented structure:

1. The API receives order requests and validates input.
2. It checks catalog data and available stock in a transactional database flow.
3. It stores order metadata and worker jobs in PostgreSQL.
4. The worker processes queued orders asynchronously.
5. Health and metrics endpoints allow monitoring and deployment validation.

## Run Locally

The recommended local setup uses Docker Compose. It starts PostgreSQL, two API
instances, and two worker instances. You do not need to install Node.js or
PostgreSQL on your computer to run the Compose setup.

### Prerequisites

- Docker Desktop installed and running (including Docker Compose)
- Python 3, if you want to run the API contract checker

### Configure and start

In PowerShell, open the repository directory and create `.env` from the example
file if you do not already have one:

```powershell
cd "C:\path\to\fulfillops"
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Review `.env` and set `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`
to local development values. Do not commit `.env` or use development
credentials in production.

Build and start the services in the background:

```powershell
docker compose up -d --build
docker compose ps
```

The first build may take a few minutes while Docker downloads the base images
and installs dependencies. Wait for the `api` service to become healthy, then
check readiness and list the seeded catalog:

```powershell
Invoke-RestMethod http://localhost:8080/health/ready
Invoke-RestMethod http://localhost:8080/api/v1/catalog
```

The API is available at `http://localhost:8080`; the second API instance is at
`http://localhost:8081`. Useful endpoints include:

- `GET http://localhost:8080/health/live`
- `GET http://localhost:8080/health/ready`
- `GET http://localhost:8080/api/v1/catalog`
- `GET http://localhost:8080/api/v1/inventory/KIT-100`
- `GET http://localhost:8080/metrics`

To create a sample order from PowerShell:

```powershell
$headers = @{ "Idempotency-Key" = [guid]::NewGuid().ToString() }
$body = @{
    customer_id = "CUST-LOCAL"
    items = @(@{ sku = "KIT-100"; quantity = 1 })
} | ConvertTo-Json -Depth 4
$order = Invoke-RestMethod -Method Post `
    -Uri http://localhost:8080/api/v1/orders `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $body
```

The response contains an `order_id`. Check its status with:

```powershell
Invoke-RestMethod "http://localhost:8080/api/v1/orders/$($order.order_id)"
```

### Run the API contract checker

The checker creates orders and consumes inventory. Run it only against this
local/test stack, never against production:

```powershell
python tests\fulfillops_public_checker.py --base-url http://localhost:8080
```

The optional `--concurrency` and `--stress` checks also consume stock. Run them
only against a freshly seeded, isolated test database:

```powershell
python tests\fulfillops_public_checker.py --base-url http://localhost:8080 --concurrency --stress
```

### Logs and shutdown

To follow service logs or stop the stack:

```powershell
docker compose logs -f
docker compose down
```

`docker compose down` preserves the database volume. To permanently delete the
local database and its data, use `docker compose down -v`; the migrations and
seed data run again the next time the stack starts.

## API Endpoints

### Health

- `GET /health/live`
- `GET /health/ready`

### Catalog

- `GET /api/v1/catalog`
- `GET /api/v1/inventory/:sku`

### Orders

- `POST /api/v1/orders`
- `GET /api/v1/orders/:order_id`

### Observability

- `GET /metrics`

## Database Schema

The initial schema includes:

- `catalog`
- `orders`
- `order_items`
- `worker_jobs`

Sample catalog records are seeded during the initial migration.

## Notes

This repository is intended for a DevOps-focused lab environment and demonstrates operational patterns such as container orchestration, monitoring, and service reliability.

## License

This project is for educational and laboratory use.
