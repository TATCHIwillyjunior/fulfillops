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

## Local Development

### Prerequisites

- Docker and Docker Compose
- Node.js 18+
- PostgreSQL client tools (optional, for direct DB inspection)

### Start the stack

```bash
docker compose up --build
```

This starts the application and database services defined in `compose.yaml`.

### Environment variables

The project uses a `.env` file based on the example file:

```bash
cp .env.example .env
```

Adjust the values to match your local environment before running the services.

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
