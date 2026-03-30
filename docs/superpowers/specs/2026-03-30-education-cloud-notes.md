# Education / Cloud Mode — Future Concept Notes

> These are early-stage notes, not a design spec. Captured from a conversation
> about university adoption (machining program in Belgium).

## The use case

A machining teacher wants students to use Loupe for inspection exercises.
Each student needs:
- Their own workspace (images, DXF files, measurements, sessions)
- Ability to save work and come back later
- No software installation (browser-only)

The teacher needs:
- See all students' work (review submissions)
- Pre-load DXF files and templates for assignments
- Class management (create/archive student accounts)

## How this builds on what we have

The multi-user hosted mode (done) already handles concurrent users with
isolated frame stores. What's missing:

| Need | Current state | What to add |
|------|--------------|-------------|
| User identity | Anonymous UUID per tab | Login (username/password or SSO) |
| Persistent storage | Frame store is in-memory (lost on restart) | Cloud storage (S3/MinIO or DB) for images, sessions, templates |
| Session persistence | localStorage (per-browser) | Server-side session storage tied to user account |
| Teacher dashboard | None | Admin view: list students, view their sessions, grade |
| Assignment flow | None | Teacher creates assignment (DXF + template), students submit results |
| Multi-tenant | Single SQLite | PostgreSQL or per-tenant SQLite |

## Architecture options

**Option A: Keep it simple — file-based multi-tenant**
- Add login (simple username/password, stored in SQLite)
- Each user gets a directory: `data/users/{user_id}/`
- Sessions, templates, images stored as files in that directory
- Teacher role can browse all user directories
- Works on a single VPS, no cloud services needed

**Option B: Cloud-native**
- Auth via OAuth2 (Google/Microsoft SSO — universities have this)
- Object storage (S3/MinIO) for images and sessions
- PostgreSQL for user accounts, run history, SPC data
- Horizontal scaling possible
- More complex but scales to hundreds of students

**Recommendation:** Start with Option A. A machining class has 15-30 students.
A single VPS with file-based storage handles this easily. If adoption grows
beyond one university, migrate to Option B.

## What NOT to do

- Don't build a full LMS (Learning Management System) — integrate with
  existing LMS via LTI (Learning Tools Interoperability) if needed
- Don't build real-time collaboration (Google Docs style) — each student
  works independently
- Don't build a grading system — the teacher reviews inspection results
  and grades externally

## Priority

This is a **future initiative**, not near-term. The foundation is:
1. ✅ Multi-user hosted mode (done)
2. Measurement templates (in progress — enables assignments)
3. Run storage + SPC (planned — enables submission/review)
4. Login + user storage (new work)
5. Teacher dashboard (new work)

Steps 1-3 are on the current roadmap. Steps 4-5 are the new work specific
to the education use case.
