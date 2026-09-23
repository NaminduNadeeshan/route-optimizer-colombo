#!/bin/bash
set -e

# Base directories
BASE_DIR="$(pwd)"
DATA_DIR="${BASE_DIR}/data"
PROFILES_DIR="${BASE_DIR}/profiles"

# OSM File details
OSM_URL="https://download.geofabrik.de/asia/sri-lanka-latest.osm.pbf"
PBF_FILE="${DATA_DIR}/sri-lanka-latest.osm.pbf"

echo "=== 1. Downloading Sri Lanka OSM data ==="
if [ ! -f "${PBF_FILE}" ]; then
  wget -O "${PBF_FILE}" "${OSM_URL}"
else
  echo "Sri Lanka OSM data already downloaded."
fi

echo "=== 2. Extracting default OSRM profiles ==="
# Extract profiles from the docker image to our local directory
docker run --rm -v "${PROFILES_DIR}:/host_profiles" osrm/osrm-backend:latest sh -c "cp -r /opt/car.lua /opt/lib /host_profiles/ 2>/dev/null || cp -r /opt/* /host_profiles/"

echo "=== 3. Creating custom motorcycle.lua profile ==="
cp "${PROFILES_DIR}/car.lua" "${PROFILES_DIR}/motorcycle.lua"

# Patch the speeds for motorcycle context in Sri Lanka
# We use awk to replace primary and residential speeds safely within the speeds block
awk '
/primary[[:space:]]*=[[:space:]]*[0-9]+/ {
    sub(/[0-9]+/, "40")
}
/residential[[:space:]]*=[[:space:]]*[0-9]+/ {
    sub(/[0-9]+/, "20")
}
{ print }
' "${PROFILES_DIR}/motorcycle.lua" > "${PROFILES_DIR}/motorcycle.lua.tmp" && mv "${PROFILES_DIR}/motorcycle.lua.tmp" "${PROFILES_DIR}/motorcycle.lua"

echo "Custom motorcycle.lua created with updated speeds."

echo "=== 4. Extracting the graph ==="
docker run --rm -t -v "${DATA_DIR}:/data" -v "${PROFILES_DIR}:/opt/profiles" osrm/osrm-backend:latest osrm-extract -p /opt/profiles/motorcycle.lua /data/sri-lanka-latest.osm.pbf

echo "=== 5. Partitioning the graph (MLD) ==="
docker run --rm -t -v "${DATA_DIR}:/data" osrm/osrm-backend:latest osrm-partition /data/sri-lanka-latest.osrm

echo "=== 6. Customizing the graph ==="
docker run --rm -t -v "${DATA_DIR}:/data" osrm/osrm-backend:latest osrm-customize /data/sri-lanka-latest.osrm

echo "=== Setup Complete! ==="
echo "You can now start the routing engine using: docker-compose up -d"
