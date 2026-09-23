import requests
import random
import math
from datetime import datetime, timedelta

def get_snapped():
    lat = random.uniform(6.8200, 6.9800)
    lon = random.uniform(79.8400, 79.9800)
    res = requests.get(f"http://localhost:5005/nearest/v1/driving/{lon},{lat}?number=1")
    return res.json()['waypoints'][0]['location']

print(get_snapped())
