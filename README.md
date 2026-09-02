# AWIP — AI Workforce Intelligence Platform

An AI-powered workforce management platform built for the **Ahmedabad Municipal Corporation (AMC)**, developed during my internship as an **SDE & AI/ML Engineering Intern at RODIC Consultants Pvt. Ltd.** This repository is shared with RODIC's permission as a portfolio project — the version here was used for client demos and is not connected to any live production or citizen data.

## What it does

AWIP gives HR administrators, department heads, and employees a single dashboard for workforce operations across a large municipal organization (10,000+ employee dataset): employee records, task and project management, payroll, leave, grievances, legal/statutory compliance, and recruitment/onboarding — plus an AI layer on top of it all.

**AI features:**
- **Heera** — a conversational AI assistant grounded in live database data, not canned responses. It can look up a specific employee's leave balance, rank top performers in a department by real appraisal data, summarize whichever page you're currently on (Finance, Legal, Grievances, etc.) using that page's actual data, and generate downloadable PDF reports.
- **6 autonomous predictive-analytics agents** running on a schedule, each using regression-based trend forecasting with confidence scoring: workforce demand, capacity shortfalls, attendance risk, budget overruns, skill-gap/retirement risk, and weather-driven staffing recommendations (using live weather data for flood-prone departments).
- **AI-assisted grievance handling** — automatic sentiment/severity analysis on filing, auto-escalation, and AI-drafted response emails.

## My contributions

I worked on this as a hands-on full-stack + AI engineer:
- Built and hardened the **Heera** conversational assistant's data-grounding layer — role-gated employee lookup, page-aware context so summaries reflect real data instead of generic responses, and more robust natural-language intent matching.
- Extended the **predictive-analytics agent system** with a manual "run now" trigger and richer idle-state reporting (showing real near-threshold trends instead of a content-free "no action needed").
- Diagnosed and fixed a **critical database connection defect** that was silently breaking the AI service for every user after any single failed query — a production-reliability bug, not just a feature gap.
- Set up and ran the full local development environment (Docker/Postgres, Bun/Node, Python/FastAPI) and led Git-based integration of a distributed team's concurrent feature branches.

## Tech stack

- **Frontend**: React 19, TanStack Start/Router, Vite, Tailwind CSS (built with [Bun](https://bun.sh))
- **Core API** (`server-core`): Node.js, Express, Prisma ORM, PostgreSQL
- **AI service** (`server-ai`): Python, FastAPI, PostgreSQL (direct SQL), Z.AI (GLM) / OpenRouter for LLM inference
- **Database**: PostgreSQL (Docker locally; Neon Postgres in the shared dev environment)

## Live demo

_Coming soon — a private demo deployment is in progress._

## Running it locally

```bash
# 1. Install dependencies
bun install                          # frontend
(cd server-core && bun install)      # core API
(cd server-ai && python -m venv .venv && ./.venv/bin/pip install -r requirements.txt)

# 2. Set up environment files
cp .env.example .env
cp server-core/.env.example server-core/.env   # fill in DATABASE_URL / JWT_SECRET
cp server-ai/.env.example server-ai/.env       # fill in ZAI_API_KEY or OPENROUTER_API_KEY

# 3. Start Postgres (Docker)
docker compose up -d database

# 4. Run migrations and seed demo data
cd server-core && bun x prisma migrate dev && bun run seed && cd ..

# 5. Run all three services (separate terminals)
bun run dev                             # frontend — http://localhost:8080
(cd server-core && bun run server.js)   # core API  — http://localhost:5000
(cd server-ai && ./.venv/bin/python main.py)   # AI service — http://localhost:8000
```

## Demo login

| Role | Email | Password |
|---|---|---|
| HR Admin | hr.admin@amc.gov.in | AmcHR@2026 |
| Department Head | dept.head@amc.gov.in | AmcDH@2026 |
| Employee (self-service) | employee.demo@amc.gov.in | AmcEmp@2026 |

These are seeded demo credentials for a synthetic dataset generated for demo purposes — no real employee data.

## Database

Schema lives in `server-core/prisma/schema.prisma`.

```bash
cd server-core
bun x prisma migrate dev --name <description>   # after changing the schema
bun run seed                                     # reseed demo data
```

---

This project was originally developed at RODIC Consultants Pvt. Ltd. for a real client engagement and is shared here, with the organization's permission, as a portfolio piece.
