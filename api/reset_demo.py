import sqlite3
from datetime import datetime, timedelta

conn = sqlite3.connect('data/hameleonweb.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()

username = 'floydrose'
client = cur.execute(
    "SELECT id, username FROM clients WHERE lower(username) = lower(?)",
    (username,)
).fetchone()

if not client:
    print(f"User @{username} not found")
    conn.close()
    exit(1)

print(f"Found user: {dict(client)}")

now = datetime.utcnow()
trial_start = now.isoformat()
trial_end = (now + timedelta(days=7)).isoformat()

cur.execute(
    """UPDATE licenses 
       SET trial_used = 1,
           trial_started_at = ?,
           expires_at = ?,
           status = 'trial'
       WHERE client_id = ?""",
    (trial_start, trial_end, client['id'])
)

print(f"Demo reset for @{username}:")
print(f"  trial_started_at: {trial_start}")
print(f"  expires_at: {trial_end}")
print(f"  status: trial")

conn.commit()
conn.close()
print("Done!")
