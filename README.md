# CacheForge 

**CacheForge is an in-memory database built with TypeScript. It stores data as key-value pairs and automatically removes outdated cached data when the original data changes.**

The main goal of this project is to understand how databases and caching systems work internally.

Unlike a basic key-value store, CacheForge allows us to create relationships between keys. When one key changes, the system automatically invalidates the cache entries that depend on it.

##  Live Demo

* **Live Dashboard:** https://cacheforge-frontend-wgb7.onrender.com
* **Backend:** https://cacheforge-backend-9g2l.onrender.com
* **GitHub Repository:** https://github.com/sohail06015/CacheForge

> **Note:** The backend runs on Render's free service, which may sleep after inactivity. The first request after a period of inactivity can take longer than usual.

##  What Does CacheForge Do?

Imagine that an application stores a user's profile in a database and keeps a cached copy to make future requests faster.

When the user's information changes, the cached profile may become outdated.

Normally, developers must manually remove or update that cached data.

**CacheForge solves this problem by tracking dependencies between keys and automatically invalidating dependent cache entries when their source data changes.**

This helps prevent applications from using outdated cached data.

##  Features

* **In-memory storage:** Stores data in memory for fast access.
* **Key-value operations:** Stores and retrieves values using keys.
* **Redis-compatible communication:** Supports communication through the RESP protocol over TCP.
* **Automatic cache invalidation:** Removes dependent cache entries when their source data changes.
* **Dependency tracking:** Creates relationships between keys.
* **Key expiration:** Supports expiration of keys after a specified time.
* **Multiple data structures:** Supports strings, lists, hashes, sets, and sorted sets.
* **Data persistence:** Uses an append-only file mechanism to record commands and replay saved data during startup.
* **Publish/subscribe:** Supports sending messages to subscribers.
* **Interactive dashboard:** Provides a visual interface for inspecting keys and running commands.
* **Command-line interface:** Provides a way to interact with the database through a terminal.

##  How Automatic Cache Invalidation Works

Let's understand the main feature with an example.

Suppose we have two keys:

* `user:1` stores a user's name.
* `cache:profile:1` stores the cached profile for that user.

The cached profile depends on the user's information.

### Step 1: Store the user's name

```text
SET user:1 alice
```

Expected output:

```text
OK
```

### Step 2: Store the cached profile

```text
SET cache:profile:1 html
```

Expected output:

```text
OK
```

### Step 3: Create a dependency

```text
DEPEND cache:profile:1 user:1
```

Expected output:

```text
OK 1
```

This tells CacheForge that `cache:profile:1` depends on `user:1`.

### Step 4: Check whether both keys exist

```text
EXISTS user:1 cache:profile:1
```

Expected output:

```text
(integer) 2
```

Both keys exist.

### Step 5: Update the user's name

```text
SET user:1 bob
```

Expected output:

```text
OK
```

CacheForge automatically invalidates the dependent cached profile.

### Step 6: Check the cached profile again

```text
EXISTS cache:profile:1
```

Expected output:

```text
(integer) 0
```

The cached profile no longer exists, but `user:1` remains.

**This is the main feature of CacheForge: automatically invalidating cached data when its source changes.**

The above workflow has been tested successfully on the live deployment.

##  Technologies Used

| Technology     | Purpose                                                               |
| -------------- | --------------------------------------------------------------------- |
| TypeScript     | Writing the database and backend logic                                |
| Node.js        | Running the backend                                                   |
| React          | Building the dashboard                                                |
| Vite           | Building and running the frontend                                     |
| TCP and RESP   | Communicating with the database through the Redis-compatible protocol |
| WebSockets     | Supporting live dashboard updates                                     |
| HTML and CSS   | Building the dashboard interface                                      |
| Git and GitHub | Managing and storing the source code                                  |
| Render         | Deploying the frontend and backend                                    |

##  Project Architecture

CacheForge has three main components.

### 1. Database Engine

The database engine stores keys and values in memory.

It handles commands such as `SET` and `EXISTS`, manages key expiration, and tracks dependencies between keys.

### 2. Backend Server

The backend provides two main services:

* **HTTP API:** Communicates with the dashboard.
* **RESP server:** Accepts Redis-compatible commands over TCP.

The backend also handles persistence and replays saved commands during startup.

### 3. Frontend Dashboard

The dashboard provides a visual way to interact with CacheForge.

Users can inspect keys, run commands, and view statistics such as the number of keys, commands, expired keys, invalidated keys, and dependency links.

### Architecture Overview

```text
                 User
                  |
                  v
          CacheForge Dashboard
             React + Vite
                  |
                  v
              HTTP API
                  |
                  v
          CacheForge Database
                  |
          +-------+-------+
          |               |
          v               v
      Key-Value       Dependency
       Storage          Graph
          |
          v
    Cache Invalidation

Terminal / Redis-Compatible Client
                  |
                  v
            RESP over TCP
                  |
                  v
          CacheForge Database
```

##  Project Structure

```text
CacheForge/
│
├── backend/          # Database engine and backend server
├── frontend/         # React dashboard
├── cli/              # Command-line interface
├── docs/              # Project documentation
├── scripts/           # Helper scripts
├── package.json       # Root project configuration
├── package-lock.json  # Dependency lock file
└── README.md          # Project documentation
```

##  Run CacheForge Locally

Follow these steps to run the project on your computer.

### Prerequisites

Install the following:

* Node.js
* npm
* Git

### Step 1: Clone the repository

```bash
git clone https://github.com/sohail06015/CacheForge.git
```

### Step 2: Open the project folder

```bash
cd CacheForge
```

### Step 3: Install dependencies

```bash
npm install
```

### Step 4: Start the backend

Open a terminal in the project root and run:

```bash
npm run dev:backend
```

### Step 5: Start the frontend

Open another terminal in the project root and run:

```bash
npm run dev:frontend
```

### Step 6: Start the CLI (optional)

Open another terminal and run:

```bash
npm run dev:cli
```

Use the commands supported by your local CLI to interact with the database.

**Note:** Check the project configuration for the exact local ports and any additional setup requirements.

##  Deployment

The frontend and backend are deployed separately on Render.

### Frontend

The frontend is hosted as a Render Static Site.

Its environment variable is:

| Variable        | Purpose                     |
| --------------- | --------------------------- |
| `VITE_API_BASE` | URL of the deployed backend |

Example:

```text
VITE_API_BASE=https://cacheforge-backend-9g2l.onrender.com
```

### Backend

The backend is hosted as a Render Web Service.

The backend uses these environment variables:

| Variable              | Purpose                                      |
| --------------------- | -------------------------------------------- |
| `cacheforge_DATA_DIR` | Directory used for storing persistence files |
| `cacheforge_PASSWORD` | Optional password for authentication         |

Example data directory:

```text
/tmp/cacheforge
```

The password should be configured privately in Render and must not be committed to GitHub or exposed through the frontend.

### Deployment Limitations

* Render's free service may sleep after inactivity.
* The `/tmp` directory is temporary, so data stored there may be lost after a restart or redeployment.
* The HTTP API and RESP server use separate ports. A standard Render Web Service does not automatically expose both ports publicly, so remote CLI access may require a different hosting arrangement.
* CacheForge is an educational project and is not yet a production-ready replacement for Redis.

## Dashboard

The CacheForge dashboard allows users to:

* View stored keys.
* Run database commands.
* Inspect key details.
* View command statistics.
* Monitor expired and invalidated keys.
* Inspect dependency information.

Try the live dashboard here:

**https://cacheforge-frontend-wgb7.onrender.com**

##  What I Learned

Building CacheForge helped me understand:

* How an in-memory key-value database works.
* How a client communicates with a server using TCP.
* How Redis-compatible command protocols work.
* How to track dependencies between cached values.
* How to invalidate outdated cached data automatically.
* How to build a database dashboard using React.
* How to connect a frontend to a backend API.
* How to deploy a full-stack application using GitHub and Render.
* Why data persistence and deployment environments matter.

##  Future Improvements

Some improvements I would like to explore are:

* **LRU eviction:** Remove the least recently used keys when memory reaches a configured limit.
* **Durable storage:** Preserve data across server restarts and redeployments.
* **Better monitoring:** Add memory usage, cache hit and miss rates, and eviction statistics.
* **Command history:** Provide more detailed command logs in the dashboard.
* **Performance improvements:** Test and improve performance with larger datasets.
* **More automated tests:** Cover edge cases in dependency tracking, expiration, persistence, and invalidation.
* **Improved security:** Add appropriate authentication and secure communication for remote access.

These are planned improvements, not claims that all of them are already implemented.

##  Author

**Sohail Ansari**

* GitHub: https://github.com/sohail06015
* Project: https://github.com/sohail06015/CacheForge

---

**CacheForge is a learning project built to explore database internals, caching, dependency tracking, and backend system design.**
