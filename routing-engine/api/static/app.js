// Initialize map centered on Colombo
const map = L.map('map').setView([6.9271, 79.8612], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
}).addTo(map);

let points = []; // Array of {lat, lon}
window.markers = [];
let routeLines = [];

// Click to add points
map.on('click', function(e) {
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    points.push({lat, lon});
    
    // Create marker icon
    const isDepot = points.length === 1;
    const iconClass = isDepot ? 'depot-marker' : 'drop-marker';
    const iconHtml = isDepot ? 'D' : points.length - 1;
    
    const icon = L.divIcon({
        className: iconClass,
        html: iconHtml,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });
    
    const marker = L.marker([lat, lon], {icon: icon}).addTo(map);
    window.markers.push(marker);
    
    document.getElementById('val-drops').innerText = points.length > 1 ? points.length - 1 : 0;
});

// Clear everything
document.getElementById('btn-clear').addEventListener('click', () => {
    points = [];
    window.markers.forEach(m => map.removeLayer(m));
    window.markers = [];
    routeLines.forEach(l => map.removeLayer(l));
    routeLines = [];
    document.getElementById('val-drops').innerText = '0';
    document.getElementById('val-dist').innerText = '0 km';
    document.getElementById('val-time').innerText = '0 min';
    document.getElementById('route-steps').innerHTML = '';
});

// Optimize!
document.getElementById('btn-optimize').addEventListener('click', async () => {
    if (points.length < 2) {
        alert("Please add at least a Depot and one drop-off point!");
        return;
    }
    
    document.getElementById('loading-overlay').classList.remove('hidden');
    document.getElementById('loading-overlay').classList.add('flex');
    
    try {
        const depot = points[0];
        const drops = points.slice(1);
        
        // 1. Create orders in DB
        const dropLocations = drops.map(p => [p.lon, p.lat]);
        const orderRes = await fetch('/api/v1/create-orders', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({locations: dropLocations})
        });
        const orderData = await orderRes.json();
        
        if (!orderRes.ok) {
            throw new Error(orderData.detail || "Failed to create orders");
        }
        
        const orderIds = orderData.order_ids;
        
        // Calculate max allowed duration from Start and Deadline inputs
        const startTimeVal = document.getElementById('start-time').value || "09:00";
        const endTimeVal = document.getElementById('end-time').value || "17:00";
        
        const [sHours, sMinutes] = startTimeVal.split(':');
        const [eHours, eMinutes] = endTimeVal.split(':');
        
        let startTimestamp = new Date();
        startTimestamp.setHours(parseInt(sHours), parseInt(sMinutes), 0, 0);
        
        let endTimestamp = new Date();
        endTimestamp.setHours(parseInt(eHours), parseInt(eMinutes), 0, 0);
        
        // If deadline is earlier in the day than start time, assume it's for the next day
        if (endTimestamp <= startTimestamp) {
            endTimestamp.setDate(endTimestamp.getDate() + 1);
        }
        
        const maxDurationSecs = Math.floor((endTimestamp - startTimestamp) / 1000);
        
        // 2. Call Optimize endpoint
        const optRes = await fetch('/api/v1/optimize-route', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                rider_id: 99, // Test rider
                depot_location: [depot.lon, depot.lat],
                order_ids: orderIds,
                max_duration_seconds: maxDurationSecs,
                start_hour: parseInt(sHours)
            })
        });
        
        if (!optRes.ok) {
            const err = await optRes.text();
            throw new Error(err);
        }
        
        const data = await optRes.json();
        renderRoute(data);
        
    } catch (err) {
        console.error(err);
        alert("Optimization failed: " + err.message);
    } finally {
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('loading-overlay').classList.remove('flex');
    }
});

function renderRoute(data) {
    // Clear old lines
    routeLines.forEach(l => map.removeLayer(l));
    routeLines = [];
    
    // Update Stats
    const distKm = (data.total_distance_meters / 1000).toFixed(2);
    const timeMin = Math.round(data.total_duration_seconds / 60);
    document.getElementById('val-dist').innerText = `${distKm} km`;
    document.getElementById('val-time').innerText = `${timeMin} min`;
    
    // Draw lines & steps
    const stepsDiv = document.getElementById('route-steps');
    stepsDiv.innerHTML = '';
    
    const sequence = data.route_sequence;
    const latlngs = [];
    
    // Determine base start time from user input
    const timeVal = document.getElementById('start-time').value || "09:00";
    const [hours, minutes] = timeVal.split(':');
    const startDate = new Date();
    startDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    const startTimestamp = startDate.getTime();
    
    sequence.forEach((step, index) => {
        if (!step.location) return;
        
        const lat = step.location[1];
        const lon = step.location[0];
        latlngs.push([lat, lon]);
        
        // Find matching marker by coordinates to update its number
        const markerIdx = points.findIndex(p => Math.abs(p.lat - lat) < 0.0001 && Math.abs(p.lon - lon) < 0.0001);
        if (markerIdx !== -1) {
            const marker = window.markers[markerIdx];
            const isDepot = step.type === 'start' || step.type === 'end';
            
            // Only update drop-off markers (don't overwrite the Depot 'D')
            if (!isDepot) {
                const icon = L.divIcon({
                    className: 'drop-marker',
                    html: index, // Re-number it based on the OPTIMIZED sequence!
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                });
                marker.setIcon(icon);
            }
            
            // Calculate ETA relative to start time
            const etaDate = new Date(startTimestamp + step.arrival * 1000);
            const etaString = etaDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            // Bind a popup to show when clicked from sidebar
            marker.bindPopup(`<b>${isDepot ? 'Depot' : 'Stop ' + index}</b><br>ETA: ${etaString}`);
        }
        
        // Add to sidebar with an onclick handler
        const etaDate = new Date(startTimestamp + step.arrival * 1000);
        const timeAtPoint = etaDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const typeLabel = step.type === 'start' ? 'Start at Depot' : 
                          step.type === 'end' ? 'Return to Depot' : 
                          `Drop-off ${index} (Job ${step.job})`;
                          
        // Calculate leg distance and travel time from previous point
        let legHtml = "";
        if (index > 0) {
            const prevStep = sequence[index - 1];
            const legDistKm = ((step.distance - prevStep.distance) / 1000).toFixed(2);
            const travelSec = step.arrival - (prevStep.arrival + (prevStep.service || 0));
            const travelMin = Math.round(travelSec / 60);
            
            legHtml = `<div class="text-xs text-gray-500 mb-2 border-l-2 border-indigo-200 pl-2 ml-1 mt-1">
                Drive ${legDistKm} km (${travelMin} min)
            </div>`;
        }
        
        const serviceMin = step.service ? Math.round(step.service / 60) : 0;
        const serviceHtml = serviceMin > 0 ? `<span class="text-amber-600 ml-2">${serviceMin} min stop</span>` : "";

        stepsDiv.innerHTML += `
            <div class="p-2 bg-white border border-gray-100 shadow-sm rounded cursor-pointer hover:bg-indigo-50 transition-colors"
                 onclick="map.setView([${lat}, ${lon}], 16); window.highlightMarker(${markerIdx}, ${index});">
                ${legHtml}
                <p class="font-bold text-indigo-700">${index}. ${typeLabel}</p>
                <p class="text-xs text-gray-600 font-semibold">ETA: ${timeAtPoint} ${serviceHtml}</p>
            </div>
        `;
    });
    
    // Split geometry into segments between stops by finding closest points
    window.routeSegmentLines = [];
    let segments = [];
    
    if (data.geometry) {
        const decodedPath = decodePolyline(data.geometry);
        
        // Find the index of the closest point in the path for each step
        let stepIndices = [];
        sequence.forEach(step => {
            if (!step.location) return;
            const targetLat = step.location[1];
            const targetLon = step.location[0];
            
            let minDist = Infinity;
            let closestIdx = 0;
            // Only search forward from the last found index to keep it sequential
            const startSearchIdx = stepIndices.length > 0 ? stepIndices[stepIndices.length - 1] : 0;
            
            for (let i = startSearchIdx; i < decodedPath.length; i++) {
                const p = decodedPath[i];
                const dist = Math.pow(p[0] - targetLat, 2) + Math.pow(p[1] - targetLon, 2);
                if (dist < minDist) {
                    minDist = dist;
                    closestIdx = i;
                }
            }
            stepIndices.push(closestIdx);
        });
        
        // Slice the path into segments based on those indices
        for (let i = 1; i < stepIndices.length; i++) {
            const startIdx = stepIndices[i-1];
            // Include the end point in this segment so lines connect seamlessly
            const endIdx = stepIndices[i] + 1; 
            segments.push(decodedPath.slice(startIdx, endIdx));
        }
    } else {
        // Fallback straight line segments
        for (let i = 1; i < latlngs.length; i++) {
            segments.push([latlngs[i-1], latlngs[i]]);
        }
    }

    // Draw the segments
    segments.forEach((seg, idx) => {
        // Ensure seg has at least 2 points
        if (seg.length < 2) return;
        
        const poly = L.polyline(seg, {color: '#4f46e5', weight: 5, opacity: 0.8}).addTo(map);
        window.routeSegmentLines.push(poly);
        routeLines.push(poly);
        
        // Add directional arrows
        const decorator = L.polylineDecorator(poly, {
            patterns: [
                {
                    offset: 25, 
                    repeat: 100, 
                    symbol: L.Symbol.arrowHead({pixelSize: 15, pathOptions: {fillOpacity: 1, color: '#1e1b4b', weight: 2}})
                }
            ]
        }).addTo(map);
        routeLines.push(decorator);
    });

    // Zoom to fit all lines
    if (latlngs.length > 0) {
        const fullLine = L.polyline(latlngs);
        map.fitBounds(fullLine.getBounds(), {padding: [50, 50]});
    }
}

// Standard Google Polyline Decoder algorithm
function decodePolyline(str, precision = 5) {
    let index = 0, lat = 0, lng = 0, coordinates = [];
    let shift = 0, result = 0, byte = null, latitude_change, longitude_change, factor = Math.pow(10, precision);

    while (index < str.length) {
        byte = null; shift = 0; result = 0;
        do {
            byte = str.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
        shift = result = 0;
        do {
            byte = str.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

        lat += latitude_change;
        lng += longitude_change;
        coordinates.push([lat / factor, lng / factor]);
    }
    return coordinates;
}

window.highlightMarker = function(markerIdx, sequenceIdx) {
    // 1. Handle Marker Popup
    if (markerIdx !== null && window.markers[markerIdx]) {
        const m = window.markers[markerIdx];
        setTimeout(() => m.openPopup(), 300);
    }
    
    // 2. Handle Line Segment Highlighting
    if (window.routeSegmentLines) {
        window.routeSegmentLines.forEach((line, idx) => {
            if (sequenceIdx !== null) {
                // If a step is clicked, highlight the line leading up to it (sequenceIdx - 1)
                if (idx === sequenceIdx - 1) {
                    line.setStyle({color: '#ef4444', weight: 8, opacity: 1.0}); // Red, thicker
                } else {
                    line.setStyle({color: '#4f46e5', weight: 5, opacity: 0.2}); // Dim others
                }
            } else {
                // Reset all lines to default
                line.setStyle({color: '#4f46e5', weight: 5, opacity: 0.8});
            }
        });
    }
};

// Reset highlights if clicking empty map space
map.on('click', function(e) {
    setTimeout(() => {
        if (!map._popup) {
            window.highlightMarker(null, null);
        }
    }, 100);
});
