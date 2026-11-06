# Privacy and GDPR

What the platform stores about people, how they get a copy or have it deleted, and how long each kind of record is kept.

There are two groups of people: **viewers**, who watch shows with ads, and **dashboard users**, who run campaigns.

## Viewers

A viewer is known only by the ID their streaming site gives the player, never by name or email. The site also says whether the viewer agreed to ads based on what they watch.

| What | Why | Kept |
|---|---|---|
| Interest profile: ads seen in each genre | Audiences. Only with consent | 90 days after the last view |
| Ads seen from each campaign each day | Frequency caps ("at most 3 times a day") | 2 days |
| Requests in the last minute | Spotting traffic from bots | 2 minutes |
| Reach and audience counts | How many different viewers saw a campaign | Daily counts 400 days, campaign totals as long as the campaign. Anonymous |

Reach and audience counts use HyperLogLog sketches. They estimate how many different IDs were seen, but nobody can be read back out of them or removed from them, so they aren't personal data and stay when a viewer's data is deleted.

### Consent

Consent is opt-in: the demo site's box starts unticked. Without consent, no interest profile is built and the viewer is never put in an audience. Unticking the box later deletes the profile already built (`DELETE /player/profile`).

### A copy and deletion

The viewer's player token proves who they are:

- `GET /player/data?token=...` returns everything above that names the viewer, as a JSON download.
- `DELETE /player/data?token=...` deletes all of it.

The demo streaming site at `/watch` has **Download my data** and **Delete my data** buttons that call these. A real streaming site would put them in its own privacy settings.

## Dashboard users

The platform stores a user's email, name, password hash, two-factor settings, the teams they belong to, their signed-in devices (browser and IP address), invitations they sent and their activity history.

### A copy and deletion

On the **Account** page:

- **Download my data** (`GET /account/export`) gives a JSON file with the profile, teams, devices, invitations sent, campaigns created and activity. Password hashes, two-factor secrets and recovery codes are left out.
- **Delete my account** (`DELETE /account`, with the password) signs the person out everywhere and removes their name, email and two-factor settings. Their activity history stays, without their email or IP addresses.

The account row stays, emptied, because campaigns point to the person who created them. Campaigns, reports and invoices belong to the team, not the person, and German law requires keeping invoices for ten years. The email is free to sign up again straight away.

Deleting is refused while it would leave something nobody can manage:

- the only owner of a team with other members must make someone else an owner first
- the only member of a team with campaigns running must pause or end them first
- the only platform admin must make someone else an admin first

## Retention limits

An hourly task deletes what's no longer needed. Running it twice changes nothing more, so every API process can run it.

| What | Deleted |
|---|---|
| Signed-in devices | 30 days after they expire or sign out |
| Email confirmation and password reset links | 30 days after they expire |
| Invitations | 30 days after they expire, accepted or not |
| Emails in the local mailbox | After 30 days |
| IP addresses in the activity history | Cleared after 90 days |
| Activity history | After two years |

The limits are in `src/modules/account/retention.ts`.

## Limits

- Backups made with `npm run db:backup` still hold deleted data until they're pruned, after 14 backups by default.
- Logs can hold IP addresses and request paths, which can include viewer IDs. How long they're kept is set where they're stored, such as Loki.
- Finding a viewer's frequency counts scans Redis, which is fine for occasional requests but slow with many millions of keys.
