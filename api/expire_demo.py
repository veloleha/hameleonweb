import sqlite3
from datetime import datetime, timedelta

# Connect to database
conn = sqlite3.connect('data/hameleonweb.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# Find user @floydrose
username = 'floydrose'
client = cur.execute(
    "SELECT id, telegram_id, username, first_name, last_name FROM clients WHERE lower(username) = lower(?)",
    (username,)
).fetchone()

if not client:
    print(f"❌ User @{username} not found in database")
    conn.close()
    exit(1)

print(f"✅ Found user: {dict(client)}")

# Find their licenses
licenses = cur.execute(
    "SELECT id, client_id, license_key, activated_at, expires_at, trial_started_at, trial_used, status FROM licenses WHERE client_id = ?",
    (client['id'],)
).fetchall()

print(f"\n📋 Found {len(licenses)} license(s):")
for lic in licenses:
    print(f"  {dict(lic)}")

expired_date = (datetime.utcnow() - timedelta(days=1)).isoformat()
trial_start = (datetime.utcnow() - timedelta(days=8)).isoformat()

if len(licenses) == 0:
    import uuid
    license_key = str(uuid.uuid4())
    cur.execute(
        """INSERT INTO licenses (client_id, license_key, activated_at, expires_at, trial_started_at, trial_used, status)
           VALUES (?, ?, ?, ?, ?, 1, 'inactive')""",
        (client['id'], license_key, trial_start, expired_date, trial_start)
    )
    print(f"\n✅ Created expired trial license for @{username}:")
    print(f"   - license_key: {license_key}")
    print(f"   - trial_started_at: {trial_start}")
    print(f"   - expires_at: {expired_date}")
    print(f"   - status: inactive")
else:
    for lic in licenses:
        cur.execute(
            """UPDATE licenses 
               SET trial_used = 1,
                   trial_started_at = ?,
                   expires_at = ?,
                   status = 'inactive'
               WHERE id = ?""",
            (trial_start, expired_date, lic['id'])
        )
        print(f"\n✅ Updated license {lic['id']} to expired:")
        print(f"   - status: inactive")
        print(f"   - expires_at: {expired_date}")

conn.commit()
conn.close()

print(f"\n🎉 Demo expired for @{username}!")
