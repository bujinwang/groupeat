# GroupEat Project Plan

## Overall Architecture:

1.  **Frontend (React Native App):**
    *   Will continue to use React Native and Expo.
    *   UI for group management.
    *   `expo-contacts` for accessing device contacts.
    *   Will communicate with the backend via a REST API for all group-related data and actions.
    *   Will handle user authentication against the backend.

2.  **Backend (Node.js/Express + TypeScript + Prisma):**
    *   A new server-side application.
    *   Will expose a REST API for the frontend to consume.
    *   Will handle business logic for user authentication, group creation, member management, invitations, etc.
    *   Will connect to a PostgreSQL database.

3.  **Database (PostgreSQL):**
    *   Hosted on Fly.io (or locally for development, e.g., `autobebe` database with `groupeat_schema`).
    *   Will store user profiles, dining groups, group members, and group invitations.

4.  **Deployment (Fly.io):**
    *   Both the backend application and the PostgreSQL database will eventually be hosted on Fly.io.

## Revised Plan Phases:

**Phase 1: Backend Foundation & Database Design [COMPLETED]**

*   **Technology Stack Selection for Backend:** Node.js with Express.js, TypeScript, and Prisma. [DONE]
*   **Database Schema Design (PostgreSQL with Prisma):** Schemas for `User`, `DiningGroup`, `GroupMember`, `GroupInvitation` defined in `groupeat-backend/prisma/schema.prisma`. [DONE]
*   **API Endpoint Design:** Initial REST API endpoints for authentication, groups, group members, and invitations defined. [DONE]
*   **Project Setup (Backend):** `groupeat-backend` project created and configured. [DONE]
*   **Initial Fly.io Setup:** Local PostgreSQL (`autobebe` database, `groupeat_schema` schema) used for development. Fly.io setup deferred. [DONE for Local Dev]

**Phase 2: Backend Core Implementation [COMPLETED for Core Features]**

*   **User Authentication:** Registration, login, JWT management, and route protection middleware implemented. [DONE]
*   **Core Group & Member Logic:** API endpoints for CRUD on groups, adding/removing members, and creating/accepting invitations implemented. [DONE]
*   **Database Migrations:** Initial migration applied. [DONE]

**Phase 3: Stage 1 Core User Flow Implementation (Backend & Frontend)**

*   **Group Creation & Management (Backend: DONE, Frontend: TODO)**
    *   API for creating groups.
    *   UI for creating groups.
*   **Member Invitation & Joining (Backend: LARGELY DONE, Frontend: TODO)**
    *   API for inviting (link/QR, direct add, email/SMS placeholder), accepting invites.
    *   UI for inviting members (contacts, link, QR).
    *   UI for accepting invites.
    *   Backend: Implement actual SMS/Email sending for invitations. [TODO]
*   **AI Restaurant Recommendation (Backend: IN PROGRESS, Frontend: TODO) [NEW MAJOR FEATURE]**
    *   **Input:**
        *   Database schema for user flavor preferences. [DONE]
        *   API endpoint for users to set/update preferences (`PUT /users/me/preferences`). [DONE]
        *   UI for users to set preferences. [TODO - Frontend]
    *   **Backend Logic:**
        *   API endpoint (e.g., `POST /groups/:groupId/recommendations`). [TODO]
        *   AI model integration & prompt engineering.
        *   Utilize group preferences, community posts/reviews (Dish/Restaurant models).
    *   **Output:**
        *   API returns a list of recommended restaurants with reasons.
        *   UI to display recommendations.
*   **Voting/Decision on Recommendations (Backend: TODO, Frontend: TODO)**
    *   Database schema for votes/likes on recommendations.
    *   API for submitting votes & viewing results.
    *   UI for voting/liking recommendations.
*   **Restaurant Info & Navigation (Backend: IN PROGRESS, Frontend: TODO)**
    *   Enhance `Restaurant` model (lat/lng). [DONE]
    *   API to provide restaurant details for navigation. [TODO]
    *   UI to display restaurant info and link to maps. [TODO - Frontend]

**Phase 4: Frontend UI Implementation for Core & Social Features [NEXT AFTER STAGE 1 LOGIC]**

*   **API Service Layer:** Create/update services in `groupeat-frontend`.
*   **Authentication Flow UI:** Login/registration screens.
*   **Group Management UI:** Create, view, manage groups and members.
*   **Contact Integration:** Use `expo-contacts` on the client; send selected contact info to backend.
*   **QR Code Invitation Flow:**
    *   Frontend requests an invitation link/token from backend.
    *   Frontend generates and displays QR code.
    *   Scanning QR code (on another device) opens a deep link into the app (or to app store if not installed) with the invitation token.
    *   App handles the token to call the `/invitations/accept` endpoint.
*   **SMS Invitation Flow:**
    *   Frontend sends contact's phone number to backend when creating an invitation.
    *   Backend (TODO for actual sending) integrates with an SMS service (e.g., Twilio) to send an invitation link.
*   **Dish Photo Sharing & Community Feed UI:** [TODO]

**Phase 5: Further Advanced Features & Deployment (Future)**

*   **Dish Photo Sharing & Community Feed (Backend API - IN PROGRESS)**
    *   Database Schema: [DONE]
    *   API Endpoints:
        *   Create dish posts: [DONE]
        *   Fetch group-specific dish post feeds: [DONE]
        *   Fetch community dish post feed: [DONE - basic implementation]
        *   Comment on dish posts: [TODO]
        *   Like/unlike dish posts: [TODO]
    *   Image Handling: [TODO]

*   **Invitation System Enhancements (Backend):**
    *   Implement actual SMS/Email sending. [TODO - Part of Stage 1]
    *   Secure token generation: [DONE]
*   **Real-time Features:** [TODO]
*   **Testing (Backend & Frontend):** [TODO]
*   **Deployment (Backend & Frontend):** [TODO]
*   **UI/UX Refinements:** [TODO]
*   **Error Handling & Validation (Backend):** More robust input validation (e.g., Zod). [TODO]
*   **Updating Member Roles (Backend):** [DONE]


## Addressing "Definition of Ready" (for Stage 1):

*   **User requirements for group structures:** Defined by PostgreSQL schema and API contracts.
*   **Technical feasibility of contact integration:** `expo-contacts` on client, backend processes data.
*   **Security and privacy requirements:** Addressed through JWT authentication, HTTPS (in production), input validation (to be enhanced), and careful handling of user data.
*   **Permission levels and user roles:** Enforced by backend logic (e.g., group admins).
*   **UI/UX designs for group management screens:** To be implemented in the frontend based on earlier discussions.

This document will be checked and updated as new features are built.
