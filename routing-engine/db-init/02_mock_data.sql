-- 1. Insert a mock rider (Nimal)
INSERT INTO riders (name, vehicle_capacity_weight, vehicle_capacity_volume) 
VALUES ('Nimal', 50.0, 100.0) 
RETURNING id;

-- 2. Insert a mock order in Colombo (Using ST_SetSRID and ST_MakePoint for Longitude/Latitude)
-- Longitude: 79.861244, Latitude: 6.927079
INSERT INTO orders (customer_name, dropoff_location, weight, volume, status, assigned_rider_id) 
VALUES (
    'Sunil - Mock Order', 
    ST_SetSRID(ST_MakePoint(79.861244, 6.927079), 4326), 
    2.5, 
    5.0, 
    'pending', 
    1
);

-- 3. Insert a mock telemetry ping for the rider
INSERT INTO telemetry_logs (rider_id, location, speed_kmh) 
VALUES (
    1, 
    ST_SetSRID(ST_MakePoint(79.861500, 6.927500), 4326), 
    35.5
);

-- 4. Query to verify the mock data was inserted and calculate distance between rider ping and order
SELECT 
    o.customer_name,
    ST_AsText(o.dropoff_location) as order_location,
    ST_AsText(t.location) as rider_location,
    -- Distance in meters (using spatial calculation on SRID 4326 cast to geography)
    ST_Distance(o.dropoff_location::geography, t.location::geography) as distance_meters
FROM orders o
JOIN telemetry_logs t ON o.assigned_rider_id = t.rider_id;
