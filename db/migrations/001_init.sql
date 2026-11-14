-- Migration 001: Initial Schema for FulfillOps

-- 1. Catalog Table
CREATE TABLE IF NOT EXISTS catalog (
    sku VARCHAR(64) PRIMARY KEY,
    unit_price_cents INT NOT NULL CHECK (unit_price_cents >= 0),
    available INT NOT NULL CHECK (available >= 0)
);

-- 2. Orders Table
CREATE TABLE IF NOT EXISTS orders (
    order_id UUID PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    total_cents INT NOT NULL CHECK (total_cents >= 0),
    idempotency_key VARCHAR(128) UNIQUE NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Order Items Table
CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    sku VARCHAR(64) NOT NULL REFERENCES catalog(sku),
    quantity INT NOT NULL CHECK (quantity > 0)
);

-- 4. Transactional Outbox / Worker Jobs Table
CREATE TABLE IF NOT EXISTS worker_jobs (
    job_id SERIAL PRIMARY KEY,
    order_id UUID UNIQUE NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    status VARCHAR(32) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
    locked_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed Data (Seed EXACTLY once)
INSERT INTO catalog (sku, unit_price_cents, available) VALUES
    ('KIT-100', 1299, 7),
    ('PART-200', 599, 12),
    ('PACK-300', 249, 5)
ON CONFLICT (sku) DO NOTHING;