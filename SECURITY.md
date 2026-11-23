# Security policy

LibreCorsa is a static site with an optional online side: a Cloudflare Worker (`cloudflare/api`) with the lap
boards, the room server, the race server, the usage counter, the live count and the private admin numbers. The parts
worth reporting are that Worker (anything that lets someone
read or change data they shouldn't, post under a name they don't own, speak as another player in a room or a race,
run up the relay bill, or knock a board or a race over), the force-feedback bridge (`npm run ffb`) and anything that
runs untrusted input in the browser.

## Reporting

Please report privately through **[Report a vulnerability](https://github.com/librecorsa/librecorsa/security/advisories/new)**
(GitHub's private vulnerability reporting) rather than in a public issue. Include what you found, how to
reproduce it and what it lets an attacker do. You'll get a reply within a week. If you can't use GitHub, write to
contact@alpyalay.org. The same contacts are in [librecorsa.org/.well-known/security.txt](https://librecorsa.org/.well-known/security.txt).

Fake lap times are a known limit, not a vulnerability: the board checks laps for plausibility but can't prove
they were driven. Reports of a specific cheated entry can go in a normal issue.

## Supported versions

Only the current `main` branch, which is what https://librecorsa.org/ runs.
