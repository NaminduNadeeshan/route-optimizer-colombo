-- Enable PostGIS extension if not already enabled
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. Riders Table
CREATE TABLE IF NOT EXISTS riders (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    vehicle_capacity_weight DECIMAL(10, 2) DEFAULT 0.0,
    vehicle_capacity_volume DECIMAL(10, 2) DEFAULT 0.0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_name VARCHAR(100) NOT NULL,
    
    -- Spatial column for strict Longitude/Latitude
    -- SRID 4326 represents the standard WGS 84 coordinate system (GPS)
    dropoff_location GEOMETRY(Point, 4326) NOT NULL,
    
    -- Constraints for optimization
    weight DECIMAL(10, 2) DEFAULT 0.0,
    volume DECIMAL(10, 2) DEFAULT 0.0,
    
    -- Time windows (e.g., must be delivered between 14:00 and 16:00)
    time_window_start TIMESTAMP WITH TIME ZONE,
    time_window_end TIMESTAMP WITH TIME ZONE,
    
    -- Delivery status & assignment
    status VARCHAR(50) DEFAULT 'pending',
    assigned_rider_id INTEGER REFERENCES riders(id),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create a spatial index for fast geographic queries (like clustering or finding nearby orders)
CREATE INDEX IF NOT EXISTS idx_orders_dropoff_location 
ON orders USING GIST (dropoff_location);


-- 3. Telemetry Logs Table
-- Highly optimized for time-series inserts from the motorcycle app
CREATE TABLE IF NOT EXISTS telemetry_logs (
    id BIGSERIAL PRIMARY KEY, -- BigSerial because this table will grow massively
    rider_id INTEGER NOT NULL REFERENCES riders(id),
    
    -- Spatial location of the ping
    location GEOMETRY(Point, 4326) NOT NULL,
    
    -- Rider's speed at the time of the ping
    speed_kmh DECIMAL(5, 2),
    
    -- When the ping occurred
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Spatial index to quickly query paths or find pings within certain road segments
CREATE INDEX IF NOT EXISTS idx_telemetry_location 
ON telemetry_logs USING GIST (location);

-- B-Tree index on timestamp for fast time-series filtering
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp 
ON telemetry_logs (timestamp);

-- Composite index to quickly fetch a specific rider's path over time
CREATE INDEX IF NOT EXISTS idx_telemetry_rider_time 
ON telemetry_logs (rider_id, timestamp);
