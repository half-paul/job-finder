# Build a Multi-Source AI Job Finder & Ranking Web Application

Build a production-ready web application called **JobFinder AI** that continuously discovers open job postings from across the internet, evaluates how well each position matches a user's qualifications and interests, and ranks the opportunities.

The application should behave like a personalized job-search agent rather than just another job board.

## 1. Primary Objective

Create a web application that:

1. Searches multiple public job-search websites.
2. Searches company/organization career pages directly.
3. Discovers job postings from common Applicant Tracking Systems (ATS).
4. Stores normalized jobs in PostgreSQL.
5. Eliminates duplicate job postings.
6. Matches jobs against a user's resume, experience, skills, career interests, location, compensation preferences, and work preferences.
7. Produces a ranked list of opportunities with an explainable **Match Score from 0–100**.
8. Runs searches automatically on a schedule.
9. Detects newly posted jobs.
10. Alerts the user when particularly strong opportunities appear.

The system must support multiple users in the future, even if the first version is single-user.

---

# 2. Target Job Sources

The architecture must use a **pluggable source-provider model** so additional job sources can easily be added later.

Support discovery from:

### Major job-search sources

Where technically and legally permitted:

- LinkedIn
- Indeed
- Glassdoor
- Google Jobs/search results
- ZipRecruiter
- Wellfound
- Dice
- Built In
- RemoteOK
- We Work Remotely
- FlexJobs or similar services when API/access is available

Prefer official APIs, public feeds, structured data, or permitted integrations rather than fragile scraping.

Do not bypass CAPTCHAs, authentication controls, robots restrictions, anti-bot protections, or website Terms of Service.

---

# 3. Company Career Pages

The application must also discover jobs **outside traditional job boards**.

Search company career sites and corporate websites.

Examples:

```text
company.com/careers
company.com/jobs
careers.company.com
jobs.company.com
```

Use search engine discovery where appropriate:

```text
site:company.com careers VP infrastructure
site:company.com careers cybersecurity
site:company.com careers artificial intelligence
```

Also identify and support major ATS platforms commonly embedded in corporate career sites.

Examples include:

- Greenhouse
- Lever
- Workday
- Ashby
- SmartRecruiters
- iCIMS
- Jobvite
- BambooHR
- Oracle Recruiting
- SAP SuccessFactors
- Workable

Create separate connectors/parsers when possible.

Example architecture:

```text
JobSourceProvider
    |
    +-- GreenhouseProvider
    +-- LeverProvider
    +-- WorkdayProvider
    +-- AshbyProvider
    +-- SmartRecruitersProvider
    +-- CompanyCareerPageProvider
    +-- SearchEngineProvider
    +-- RemoteOKProvider
    +-- OtherJobBoardProvider
```

Each provider should return jobs using the same normalized schema.

---

# 4. User Profile

Allow the user to create a detailed career profile.

Support uploading:

- Resume/CV
- LinkedIn-exported resume/profile
- TXT
- PDF
- DOCX

Extract structured information including:

```text
name
executive summary
current role
previous roles
years of experience
industries
leadership experience
technical skills
cloud platforms
security experience
AI experience
compliance experience
certifications
education
location
work authorization
languages
management experience
company-size experience
technical architecture experience
```

Store the structured profile separately from the original document.

---

# 5. Career Interests

Allow the user to specify target roles.

Initial examples:

```text
VP Infrastructure
VP Infrastructure & Security
VP Technology
VP Engineering
VP Platform Engineering
Head of Infrastructure
Head of Cloud Infrastructure
Head of Security
Head of Platform Engineering
Director Infrastructure
Director Cloud Engineering
Director Platform Engineering
Director Cybersecurity
Director Information Security
Director AI Platform
VP AI Platform
VP AI Engineering
VP AI Transformation
Chief AI Officer
Chief AI & Data Officer
Head of AI Governance
Director AI Governance
Responsible AI Leader
AI Security Leader
Technology Executive
CTO
```

The user must be able to:

- add roles
- remove roles
- assign priority weights
- create groups of related roles

Example:

```text
AI Leadership             weight: 10
Infrastructure Leadership weight: 9
Security Leadership       weight: 8
CTO                       weight: 7
Director-level roles      weight: 6
```

---

# 6. Job Search Parameters

Build a configurable filter interface.

## Employment Type

Support:

- Full-time
- Contract
- Fractional
- Consulting
- Temporary
- Permanent

Allow multiple selections.

---

## Work Location

Support:

- Remote
- Hybrid
- On-site

Allow user-defined preferences such as:

```text
Remote: highly preferred
Hybrid: acceptable
On-site: only within 50 km
```

---

## Geographic Filters

Allow:

```text
Canada
United States
Worldwide Remote
Toronto
Vancouver
British Columbia
Ontario
specific cities
specific states/provinces
```

Allow inclusion and exclusion lists.

Example:

```text
Include:
Canada
US Remote
Toronto
Vancouver

Exclude:
jobs requiring relocation
```

---

# 7. Compensation

Allow configurable:

```text
minimum salary
preferred salary
maximum salary
hourly contract rate
currency
equity preference
```

Support currencies including:

```text
CAD
USD
EUR
GBP
```

Normalize compensation for comparison when possible.

If compensation is not listed, do not automatically penalize the job heavily.

---

# 8. Seniority

Allow:

```text
Manager
Senior Manager
Director
Senior Director
VP
SVP
EVP
C-Level
Founder
Advisor
Consultant
```

Allow excluding:

```text
Junior
Intermediate
Individual Contributor
Entry Level
```

---

# 9. Company Preferences

Allow filtering or weighting based on:

```text
industry
company size
startup
scale-up
enterprise
public company
private company
SaaS
FinTech
Cybersecurity
AI
Cloud
Payments
Financial Services
HealthTech
Technology
B2B software
```

Allow:

```text
Preferred Companies
Excluded Companies
Watchlist Companies
```

Watchlist companies should be checked directly even if their jobs do not appear on external job boards.

---

# 10. Skills & Experience Matching

Match jobs against user experience.

Example skill categories:

### Executive Leadership

```text
Technology Strategy
Digital Transformation
Executive Leadership
Technical Roadmaps
Budget Management
Vendor Management
Team Leadership
Organizational Transformation
Board/Executive Communication
```

### Infrastructure

```text
AWS
Azure
GCP
Cloud Architecture
Infrastructure Engineering
Platform Engineering
Terraform
Infrastructure as Code
Kubernetes
Docker
Networking
High Availability
Disaster Recovery
Cloud Migration
```

### Security

```text
Cybersecurity
Zero Trust
IAM
SIEM
EDR
Cloud Security
Security Architecture
Threat Management
Incident Response
WAF
SOC
Security Governance
```

### Governance / Compliance

```text
PCI DSS
SOC 2
ISO 27001
NIST
NIST AI RMF
Risk Management
Policy Development
Security Governance
AI Governance
Responsible AI
Privacy
```

### AI

```text
Generative AI
LLM Platforms
AI Agents
AI Governance
Responsible AI
AI Security
RAG
AI Infrastructure
AI Platform Engineering
Model Governance
AI Risk Management
AI Transformation
```

Skills should support:

```text
Required
Preferred
Neutral
Excluded
```

and weighting.

---

# 11. Semantic Job Matching

Do NOT rely solely on keyword matching.

Use embeddings plus LLM reasoning.

The matching engine should consider:

```text
job title
job responsibilities
required experience
preferred experience
technical skills
leadership scope
company type
industry
compensation
location
work arrangement
career trajectory
executive seniority
user preferences
```

For example:

A job titled:

```text
Head of Platform
```

may actually be an excellent match for:

```text
VP Infrastructure
```

Likewise:

```text
Head of AI Infrastructure
```

may match:

```text
VP AI Platform
```

even though exact keywords differ.

---

# 12. Match Score

Calculate an explainable score between:

```text
0–100
```

Example weighting:

```text
Role/title similarity        20%
Experience alignment         20%
Technical skills             15%
Leadership scope             15%
Industry fit                 10%
Location/work arrangement    10%
Compensation                  5%
Career-interest alignment     5%
```

Weights must be configurable.

Example output:

```text
MATCH SCORE: 92

Role Fit              19/20
Experience            20/20
Technical Skills      13/15
Leadership            15/15
Industry                9/10
Location               10/10
Compensation            3/5
Career Direction        3/5
```

---

# 13. AI Evaluation

For each job, generate:

### Why this job matches

Example:

```text
Strong match because the role requires executive ownership of
cloud infrastructure, security, DevOps and compliance.

Your AWS transformation, PCI DSS leadership, infrastructure
modernization and executive leadership experience align closely
with the role.
```

### Possible gaps

Example:

```text
Potential gaps:

- Role prefers Azure experience.
- Kubernetes experience appears to be strongly preferred.
- Company requests experience managing 100+ engineers.
```

### Recommendation

Return:

```text
Excellent Match
Strong Match
Possible Match
Stretch Opportunity
Weak Match
Do Not Apply
```

---

# 14. Separate "Qualifications Match" and "Interest Match"

This distinction is important.

A candidate may be highly qualified for a job but not interested in it.

Store:

```text
qualification_score
interest_score
overall_score
```

Example:

```text
Qualification: 96
Interest:      74
Overall:       88
```

---

# 15. Career-Progression Intelligence

The matching system should consider whether the position represents:

```text
promotion
lateral move
strategic career transition
step backward
```

Example:

```text
VP Infrastructure -> VP AI Platform

Classification:
Strategic Career Transition

Reason:
Leverages infrastructure leadership while increasing AI platform
responsibility.
```

---

# 16. Database

Use:

```text
PostgreSQL
```

Prefer PostgreSQL 16+.

Use:

```text
pgvector
```

for semantic embeddings if embeddings are stored locally.

Core tables should include approximately:

```text
users
user_profiles
resumes
career_preferences
target_roles
preferred_skills
excluded_skills
companies
company_watchlists
job_sources
jobs
job_locations
job_skills
job_embeddings
job_matches
job_match_explanations
job_status_history
saved_jobs
ignored_jobs
applications
search_runs
notifications
```

---

# 17. Job Table

Example structure:

```text
jobs

id
external_id
source_id
company_id

title
normalized_title

description
requirements

employment_type

seniority_level

location
country
region
city

remote_type

salary_min
salary_max
salary_currency

job_url
application_url

source_url

posted_at
discovered_at
last_seen_at

active

description_hash
canonical_hash

embedding

created_at
updated_at
```

---

# 18. Deduplication

The same job will frequently appear on:

```text
LinkedIn
Indeed
company career site
ATS
Google search
```

Do not show it multiple times.

Use a combination of:

```text
company
normalized job title
location
external job ID
canonical URL
description similarity
description hash
embedding similarity
```

Choose the company career site or original ATS listing as the canonical source when possible.

Track all sources referencing the same job.

---

# 19. Job Lifecycle

Track when jobs appear and disappear.

Status examples:

```text
New
Active
Updated
Closing Soon
Removed
Expired
Reposted
```

Do not immediately delete disappeared jobs.

Maintain historical information so the user can see:

```text
First discovered: Sep 12
Last seen: Sep 18
Removed: Sep 19
```

---

# 20. Search Scheduling

Run discovery jobs automatically.

Support configurable schedules:

```text
hourly
every 4 hours
twice daily
daily
```

Different source connectors may have different schedules.

Example:

```text
Priority company watchlist: hourly
ATS feeds: every 4 hours
general search: twice daily
large discovery crawl: daily
```

---

# 21. Incremental Search

Do not continuously rediscover the entire internet.

Track:

```text
last search
last job ID
last posting timestamp
ETag
Last-Modified
pagination position
```

where supported.

Prioritize newly posted jobs.

---

# 22. Search Query Generation

Use AI to generate related job-title searches.

For example, if the user selects:

```text
VP Infrastructure
```

automatically search related titles including:

```text
VP Cloud Infrastructure
VP Infrastructure Engineering
VP Platform Engineering
VP Technology Infrastructure
Head of Infrastructure
Head of Cloud
Head of Platform
Director Infrastructure
Senior Director Infrastructure
```

Likewise:

```text
VP AI Platform
```

could generate:

```text
VP AI Infrastructure
VP AI Engineering
Head of AI Platform
Head of AI Infrastructure
Director AI Platform
Director AI Engineering
Head of Generative AI
VP Applied AI
```

The generated search terms should be visible and editable.

---

# 23. Search Dashboard

The main screen should show:

```text
Job
Company
Match Score
Qualification Score
Interest Score
Location
Remote Status
Salary
Source
Date Posted
Date Discovered
Status
```

Example:

```text
94 | VP AI Platform       | Acme AI     | Remote US/Canada
92 | VP Infrastructure    | Example SaaS| Toronto Hybrid
90 | Head of AI Platform  | ExampleCorp | Remote Canada
86 | Director AI Security | SecureAI    | Vancouver
```

---

# 24. Filters

Provide real-time filters for:

```text
score
job title
company
location
country
remote/hybrid/on-site
salary
employment type
seniority
industry
company size
skills
source
posting age
date discovered
```

Example:

```text
Score >= 85
Posted within 7 days
Remote OR Toronto hybrid
Salary >= $180,000
VP OR C-level
```

---

# 25. Job Detail Screen

Show:

```text
Job title
Company
Location
Salary
Employment type
Original description

Overall match score
Qualification score
Interest score

Match explanation

Strong matching skills
Missing skills
Transferable skills

Potential red flags

Career progression analysis

Company overview

Original job link
Application link
```

---

# 26. User Actions

Allow:

```text
Save
Ignore
Applied
Interviewing
Rejected
Offer
Withdrawn
Not Interested
```

Store history.

---

# 27. Learning From User Decisions

Improve ranking based on feedback.

For example:

If the user repeatedly ignores:

```text
Director IT
```

and saves:

```text
VP AI Platform
```

increase future AI-platform ranking.

Capture signals including:

```text
viewed job
saved job
ignored job
applied
interviewed
rejected
offer
manual score adjustment
```

Do not allow learning algorithms to override explicit user preferences.

---

# 28. Notifications

Allow configurable alerts.

Example:

```text
Notify immediately for Score >= 93.

Daily digest for Score >= 85.

Do not notify for Score < 85.
```

Support initially:

```text
Email
Web notifications
```

Architect the system for future:

```text
Slack
SMS
Push notification
Telegram
```

---

# 29. Daily Job Digest

Generate an AI summary:

```text
18 new relevant opportunities discovered today.

Top opportunities:

1. VP AI Platform — Company A
   Match: 95

2. VP Infrastructure — Company B
   Match: 93

3. Head of AI Platform — Company C
   Match: 91

4. CTO — Company D
   Match: 88
```

Also include:

```text
4 high-priority jobs
9 strong matches
5 possible matches
```

---

# 30. Company Discovery

The system should also discover companies worth monitoring.

For example:

If searches repeatedly find strong AI/platform jobs at a company, suggest:

```text
Add Company X to your Watchlist?
```

Allow users to categorize companies:

```text
Dream Company
High Priority
Interesting
Neutral
Avoid
```

---

# 31. Company Intelligence

Optionally enrich companies with:

```text
industry
headquarters
employee count
funding stage
public/private
website
technology stack
company description
```

Do not make unavailable information mandatory.

---

# 32. Search Agent Architecture

Create separate logical agents/services.

Example:

```text
Discovery Agent
      ↓
Job Extraction Agent
      ↓
Normalization Agent
      ↓
Deduplication Agent
      ↓
Job Enrichment Agent
      ↓
Matching Agent
      ↓
Ranking Agent
      ↓
Notification Agent
```

Agents should preferably be deterministic services where AI isn't required.

Use LLM calls only where they provide meaningful value.

---

# 33. Cost Optimization

Avoid running expensive LLM evaluations on every job.

Use a staged pipeline.

Example:

```text
Stage 1
Basic filters

        ↓

Stage 2
Keyword/BM25 matching

        ↓

Stage 3
Embedding similarity

        ↓

Stage 4
Only top candidates receive full LLM analysis
```

Example:

```text
10,000 discovered jobs

↓ filters

1,500 relevant jobs

↓ embedding matching

250 possible matches

↓ LLM evaluation

50 high-quality matches
```

---

# 34. Suggested Technical Architecture

Prefer a simple architecture that can initially run cheaply.

### Frontend

Use:

```text
Next.js
TypeScript
React
Tailwind CSS
shadcn/ui
```

---

### Backend

Prefer:

```text
Next.js server/API
```

for the MVP unless separation becomes necessary.

For background workers use:

```text
Node.js / TypeScript workers
```

or:

```text
Python
```

where Python job extraction/AI libraries provide significant advantages.

---

### Database

```text
PostgreSQL
pgvector
```

Use:

```text
Drizzle ORM
```

or Prisma if there is a strong reason.

Prefer Drizzle.

---

# 35. Background Jobs

Use an appropriate job-processing system.

Possible choices:

```text
Trigger.dev
BullMQ
Inngest
Temporal
AWS SQS
```

For the MVP, select the simplest reliable option.

Explain the choice.

---

# 36. Search & Crawling Architecture

Create:

```text
SourceConnector
```

interface.

Example:

```typescript
interface JobSourceConnector {
  name: string;

  search(
    query: SearchQuery
  ): Promise<DiscoveredJob[]>;

  fetchJob(
    jobUrl: string
  ): Promise<RawJob>;

  normalize(
    rawJob: RawJob
  ): Promise<NormalizedJob>;
}
```

Each data source should implement the interface.

---

# 37. Web Discovery

When searching arbitrary company career pages:

1. Discover career URL.
2. Detect ATS provider.
3. Look for:
   - JSON-LD JobPosting
   - structured HTML
   - ATS API endpoints
   - RSS feeds
   - sitemap data
4. Parse jobs.
5. Normalize the data.
6. Deduplicate.
7. Store it.
8. Schedule rechecking.

Prefer structured data over browser automation.

Use a headless browser only when required.

---

# 38. Browser Automation

If required, use:

```text
Playwright
```

Do not use browser automation when a public API or structured endpoint exists.

The browser worker should be isolated from the main web application.

---

# 39. Security

Implement:

```text
secure authentication
RBAC
input validation
rate limiting
CSRF protection where applicable
secure cookies
HTTPS enforcement
encrypted secrets
audit logging
dependency scanning
security headers
database least privilege
```

Never place API keys in client-side JavaScript.

Store secrets using environment variables for local development and an external secret manager in production.

---

# 40. AI Security

Job descriptions and website content must be treated as **untrusted input**.

Protect the AI pipeline against prompt injection.

For example, a job posting containing:

```text
Ignore all previous instructions...
```

must never change application behavior.

Separate:

```text
system instructions
user preferences
retrieved web content
```

The LLM should treat job descriptions only as data.

---

# 41. User Data Privacy

Resume and career information are sensitive.

Design the system so:

```text
resume data is private
job preferences are private
search history is private
LLM providers receive only required data
```

Allow future support for:

```text
data deletion
account export
retention rules
```

---

# 42. API Layer

Design APIs similar to:

```text
/api/jobs
/api/jobs/:id

/api/jobs/search

/api/jobs/:id/save
/api/jobs/:id/ignore
/api/jobs/:id/apply

/api/profile
/api/preferences

/api/companies
/api/watchlist

/api/searches
/api/searches/run

/api/matches
/api/notifications
```

---

# 43. Observability

Implement:

```text
structured logging
job-run metrics
connector error tracking
job-discovery metrics
LLM token/cost tracking
search latency
jobs discovered per source
duplicate rate
matching pipeline statistics
```

Dashboard examples:

```text
Jobs discovered today: 4,281
New jobs: 792
Relevant after filters: 136
AI evaluated: 42
Score >= 90: 7
```

---

# 44. Admin / Diagnostics

Create a diagnostics view showing:

```text
Source
Status
Last Run
Jobs Found
New Jobs
Duplicates
Errors
Next Run
```

Example:

```text
Greenhouse       Healthy     10m ago    138
Lever            Healthy     22m ago     72
Workday          Warning     30m ago      8
RemoteOK         Healthy      1h ago      4
CompanyCrawler   Healthy      2h ago     89
```

---

# 45. Search History

Store every search execution.

Example:

```text
search_run

id
source
search_parameters
started_at
completed_at

jobs_found
jobs_new
jobs_updated
jobs_duplicate

errors

duration_ms
```

This is critical for troubleshooting connectors.

---

# 46. Application Tracking

Include a lightweight Applicant Tracking System.

For saved opportunities track:

```text
Discovered
Saved
Preparing Application
Applied
Recruiter Contact
Screening Interview
Technical Interview
Executive Interview
Final Interview
Offer
Rejected
Withdrawn
```

Allow:

```text
notes
contacts
interview dates
salary discussed
follow-up date
application URL
resume version used
cover letter version
```

---

# 47. Future AI Application Assistant

Design the schema so a future feature can:

```text
generate tailored resume
generate cover letter
answer application questions
prepare interview briefing
research hiring manager
research company
identify networking contacts
```

Do NOT automatically submit applications in the initial version.

Human approval must remain required before applications are submitted.

---

# 48. UX Requirements

The application should feel like an executive intelligence dashboard rather than a consumer job board.

Prioritize:

```text
information density
fast filtering
clear score visualization
excellent table navigation
minimal clicks
keyboard navigation
responsive layout
dark/light mode
```

Avoid excessive animations.

---

# 49. Main Navigation

Use approximately:

```text
Dashboard
Jobs
Top Matches
New Jobs
Saved
Applications
Companies
Watchlist
Searches
Profile
Preferences
Settings
```

---

# 50. Dashboard

Dashboard should immediately answer:

```text
What are the best opportunities right now?

What new opportunities appeared today?

Which high-quality opportunities might I miss?

Which applications require action?
```

Example cards:

```text
New Jobs Today
128

Strong Matches
23

Excellent Matches
7

Applications Active
6
```

---

# 51. Ranking Presentation

Rank jobs primarily by match score but allow alternative sorting:

```text
Best Match
Newest
Highest Salary
Most Senior
Remote First
Company Priority
Recently Discovered
```

---

# 52. Match Confidence

Every AI-generated match should include a confidence measure.

Example:

```text
Match Score: 93
Confidence: High
```

Confidence should reflect how complete the job description and user profile are.

---

# 53. Hard Requirements vs Preferences

This distinction is critical.

Example:

Hard requirements:

```text
Must allow remote or Canadian employment.
Must be Director level or higher.
Must be full-time or contract.
```

Preferences:

```text
AI preferred
AWS preferred
SaaS preferred
FinTech preferred
```

Jobs violating a hard requirement should normally be hidden or placed in a separate category.

---

# 54. Negative Matching

Allow the user to explicitly discourage certain jobs.

Examples:

```text
help desk
desktop support
IT administrator
junior DevOps
network technician
software developer IC
24/7 operational support
```

Negative signals should significantly reduce ranking.

---

# 55. Explainability

Never return only:

```text
Match = 87
```

Explain why.

Example:

```text
87 — Strong Match

+ Executive infrastructure leadership
+ AWS transformation experience
+ Security and PCI experience
+ SaaS background
+ Team leadership

- Azure strongly preferred
- Company expects prior public-company experience
```

---

# 56. Initial Seed Profile

Seed the demo environment with an example senior technology executive profile emphasizing:

```text
Infrastructure leadership
Cloud architecture
AWS
Cybersecurity
Platform engineering
DevSecOps
PCI DSS
SOC 2
Security governance
AI governance
Generative AI
AI platforms
Responsible AI
Digital transformation
SaaS
FinTech
Payments
Executive leadership
```

Do not hard-code these into the application.

All values must remain configurable.

---

# 57. Deployment

Initially support:

```text
Docker Compose
```

for easy local deployment.

Create containers for approximately:

```text
web
worker
postgres
redis (if required)
```

Example:

```text
docker compose up
```

should launch the development environment.

---

# 58. Cloud-Ready Design

Architect the system so it can later move to AWS without major refactoring.

Potential future architecture:

```text
CloudFront
    |
Next.js
    |
Application API
    |
+-------------+
|             |
PostgreSQL   SQS
RDS           |
              |
          Worker Services
```

Possible AWS services later:

```text
ECS Fargate
RDS PostgreSQL
SQS
EventBridge Scheduler
S3
Secrets Manager
CloudWatch
CloudFront
WAF
```

Do not over-engineer the MVP around AWS.

---

# 59. Infrastructure as Code

No need for this phase.

---

# 60. Automated Testing

Implement:

```text
unit tests
integration tests
connector tests
API tests
database tests
matching-engine tests
Playwright end-to-end tests
```

Create fixtures for ATS connectors so tests do not depend entirely on live websites.

---

# 61. CI/CD

Use GitHub Actions.

Pipeline:

```text
lint
↓
typecheck
↓
unit tests
↓
integration tests
↓
security scan
↓
build
↓
container build
↓
E2E tests
↓
deploy
```

Use separate:

```text
development
staging
production
```

environments.

---

# 62. Coding Standards

Use:

```text
TypeScript strict mode
ESLint
Prettier
Zod validation
strong database typing
structured error handling
```

Avoid:

```text
any
unvalidated external data
hard-coded credentials
monolithic services
business logic inside UI components
```

---

# 63. Implementation Approach

Do not attempt every job source in the first release.

Build incrementally.

## Phase 1 — Foundation

Implement:

```text
Next.js application
PostgreSQL
authentication
user profile
resume upload
preferences
job schema
dashboard
job detail screen
```

## Phase 2 — Initial Discovery

Implement connectors for:

```text
Greenhouse
Lever
Ashby
RemoteOK
generic JSON-LD JobPosting career pages
```

## Phase 3 — Matching

Implement:

```text
normalization
deduplication
embeddings
ranking
LLM explanation
match scoring
```

## Phase 4 — Automation

Implement:

```text
scheduled search
company watchlist
notifications
daily digest
search diagnostics
```

## Phase 5 — Advanced Discovery

Add:

```text
Workday
SmartRecruiters
iCIMS
search-engine discovery
generic company crawler
additional job boards
```

## Phase 6 — Application Intelligence

Add:

```text
application tracking
tailored resume
cover letter generation
company research
interview preparation
```

---

# 64. Critical Design Principle

The system should not simply answer:

> "What jobs contain these keywords?"

It should answer:

> **"Given this person's career history, qualifications, leadership level, career goals, location constraints and interests, what are the best jobs currently available anywhere we can legitimately discover them?"**

The architecture, ranking algorithm and UI should all optimize for this objective.

---

# 65. First Development Task

Before generating large amounts of code:

1. Produce the proposed system architecture.
2. Produce an architecture diagram using Mermaid.
3. Define the PostgreSQL schema.
4. Define the source-connector interface.
5. Define the matching/ranking algorithm.
6. Define the repository structure.
7. Define the API architecture.
8. Identify which components require an LLM and which should remain deterministic.
9. Recommend the background-job framework.
10. Explain how job crawling/search discovery will respect site restrictions.
11. Identify expected infrastructure and AI costs for the MVP.
12. Produce a phased implementation plan.

Then begin implementing **Phase 1**.

Do not generate mock implementations when a real implementation can reasonably be created.

Keep the architecture simple enough for one developer assisted by AI coding agents to maintain.
