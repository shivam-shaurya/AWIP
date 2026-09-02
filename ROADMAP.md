# AWIP (AI-HR) Production Implementation Roadmap

This document outlines the **complete end-to-end development roadmap** for transitioning the current AWIP (AI Workforce Intelligence Platform) wireframe prototype into a production-ready operational application hosted in this GitHub repository: [Mudfl/AI-HR](https://github.com/Mudfl/AI-HR).

---

## 1. System Architecture Blueprint

To support a scalable rollout, the system will move to a decoupled monorepo model.

```mermaid
graph TB
    subgraph Client Layer (Vercel / Cloudflare)
        UI[React 19 + TanStack Start App]
        RQ[React Query Client Cache]
    end

    subgraph API Gateway & Identity
        GW[Nginx / Kong Gateway]
        Auth[Keycloak OIDC Authentication]
    end

    subgraph Core Services (AWS ECS / On-Premise Docker)
        Core[Go / NestJS Core API Server]
        DB[(PostgreSQL Primary DB)]
    end

    subgraph Intelligent Services (Python FastAPI)
        AI[FastAPI AI & OCR Server]
        OCR[OpenCV + PaddleOCR Engine]
        LLM[Llama-3-8B Orchestrator]
        VecDB[(pgvector Embeddings Index)]
    end

    UI -->|JSON requests / JWT auth| GW
    GW --> Auth
    GW --> Core
    GW --> AI
    Core --> DB
    AI --> VecDB
    AI -.->|Read replica queries| DB
```

---

## 2. Phased Development Timeline

The roadmap is structured into **5 sequential phases** to ensure structured testing, secure identity setup, and smooth migration from mock data to real APIs.

### Phase 1: Workspace Refactoring & Monorepo Setup (Weeks 1 - 2)
Establish a local containerized monorepo workspace ready for developers working in VS Code Codespaces.

*   **Step 1.1: Restructure monorepo directory**:
    *   Move the current React frontend code into a dedicated `/client` folder.
    *   Initialize `/server-core` (Express/NestJS core API) and `/server-ai` (FastAPI Python engine) folders.
*   **Step 1.2: Orchestrate local services**:
    *   Configure `docker-compose.yml` to spin up local development dependencies:
        *   **PostgreSQL 15** with `pgvector` extension.
        *   **Redis** (as BullMQ task broker for asynchronous OCR jobs).
        *   **MinIO** (local S3 alternative for scanned PDF storage).
*   **Step 1.3: Configure Codespace Environment**:
    *   Configure `.devcontainer/devcontainer.json` to automatically install Bun, Python 3.10, Docker, and Git credentials upon launching the Codespace.

---

### Phase 2: Database Schema & Core APIs (Weeks 3 - 5)
Create database structures and backend CRUD endpoints to handle employees, roles, tasks, and payroll logs.

*   **Step 2.1: Design DB schema (PostgreSQL)**:
    *   Build relational models for:
        *   `employees` (ID, designation, department, cadre, active status).
        *   `service_books` (history of transfers, promotions, leaves).
        *   `tasks` (assignments, milestones, SLA status, AI risk indices).
        *   `payroll` (component breakdowns: Basic, HRA, Dearness Allowance).
*   **Step 2.2: Build Core endpoints (`server-core`)**:
    *   Expose employee directories (`GET /api/v1/employees?dept=Health&zone=Central`).
    *   Expose digital twin profiles (`GET /api/v1/employees/:id/twin`).
    *   Expose task force reallocations (`PUT /api/v1/tasks/:id/reassign`).
*   **Step 2.3: Integrate Keycloak Identity Provider (OIDC)**:
    *   Configure role-based access controls (RBAC) separating administrative officers, department heads, and the Commissioner.

---

### Phase 3: Intelligent OCR & AI Services (Weeks 6 - 8)
Build the algorithms that extract text from historical documents and run the interactive Copilot chat.

*   **Step 3.1: Document Digitization Pipeline (`server-ai`)**:
    *   Create file upload endpoint: `POST /api/v1/digitization/upload`.
    *   Deploy **PaddleOCR** or **AWS Textract** for layout detection and bilingual (Gujarati & English) text extraction from scanned service books.
    *   Create regular expression parsers and **SpaCy** models to extract structured history fields (postings, dates, grade pay changes) and write them directly into the PostgreSQL database.
*   **Step 3.2: AI Copilot RAG setup**:
    *   Convert AMC service rulebooks and regulations into vector embeddings using `bge-large-en-v1.5`.
    *   Load embeddings into **pgvector** or **Milvus**.
    *   Configure **LlamaIndex** to fetch rulebook citations and compile them into prompts for local **Llama-3-8B** queries.

---

### Phase 4: Frontend API client connection (Weeks 9 - 10)
Connect the visual screens to our new live services, replacing local state variables with API calls.

*   **Step 4.1: Integrate React Query**:
    *   Install `@tanstack/react-query` in the client.
    *   Replace mock data calls in `index.tsx`, `employees.$id.tsx`, and `org360.tsx` with react-query hooks:
        ```typescript
        const { data: employees } = useQuery({
          queryKey: ['employees', department, zone],
          queryFn: () => fetchEmployees(department, zone)
        });
        ```
*   **Step 4.2: Auth Interceptors**:
    *   Set up axios/fetch request interceptors to automatically attach Keycloak JWT bearer tokens to outbound API requests.

---

### Phase 5: Production Deployment & Compliance (Weeks 11 - 12)
Prepare the system for hosting, security audits, and go-live.

*   **Step 5.1: Build CI/CD workflow (GitHub Actions)**:
    *   Automate build compiles and unit tests on every pull request.
    *   Configure auto-deploy: Frontend client to Vercel/Cloudflare Pages; Backend containers to AWS ECS or private VM servers.
*   **Step 5.2: CERT-In Security Audit**:
    *   Perform vulnerability testing (OWASP Top 10) and obtain security compliance certification required for government applications.
*   **Step 5.3: Parallel Run**:
    *   Run both the legacy database systems and AWIP in parallel for 60 days to verify payroll and service records sync consistency before fully shutting down legacy portals.
