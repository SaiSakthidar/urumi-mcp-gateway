# Architecture

```mermaid
flowchart LR
  classDef pub fill:#e8f1ff,stroke:#2b6cb0,color:#1a365d
  classDef core fill:#fff4e0,stroke:#c05621,color:#5f370e
  classDef int fill:#eef7ee,stroke:#2f855a,color:#22543d
  classDef data fill:#f3eefb,stroke:#6b46c1,color:#44337a
  classDef ext fill:#f5f5f5,stroke:#718096,color:#2d3748

  subgraph clients["Clients"]
    direction TB
    browser["Browser<br/>dashboard + chat"]
    mcpc["Claude Code / Cursor<br/>MCP client"]
  end

  ingress{{"Traefik Ingress<br/>app.* and shop.*<br/>(the only public entry)"}}

  subgraph platform["namespace: platform"]
    direction TB
    dash["dashboard<br/>React SPA (nginx)"]
    gw["gateway<br/>MCP server for clients<br/>MCP client for upstreams<br/>chat agent + callTool()"]
    prov["provisioner<br/>only pod with K8s API access"]
    pg[("Postgres<br/>users, key hashes, encrypted creds,<br/>rules, audit, desired state")]
  end

  subgraph mcp["namespace: mcp"]
    direction TB
    woo["woo-mcp<br/>store tools"]
    every["everything-mcp<br/>demo tools"]
  end

  subgraph store["namespace: store"]
    direction TB
    wp["WordPress + WooCommerce"]
    db[("MariaDB")]
  end

  subgraph extra["created on demand"]
    direction TB
    stores["store-* namespaces<br/>one per store"]
    hosted["mcp-hosted<br/>containers from images"]
  end

  llm["LLM API"]
  gh["Remote MCP<br/>e.g. GitHub"]

  browser -->|"session cookie"| ingress
  mcpc -->|"Bearer API key or OAuth"| ingress
  ingress --> dash
  ingress -->|"/api  /mcp  /oauth"| gw
  ingress -->|"shop.*"| wp

  gw --> pg
  gw -->|"tool loop"| llm
  gw -->|"upstream credential,<br/>never the client's"| woo
  gw --> every
  gw -->|"HTTPS only"| gh
  woo -->|"signed REST"| wp
  wp --> db

  prov -->|"reads desired state"| pg
  prov -.->|"helm install"| stores
  prov -.->|"deploy"| hosted
  gw -.->|"registers tools"| stores
  gw -.-> hosted

  class ingress pub
  class dash,gw,prov core
  class woo,every,wp,stores,hosted int
  class pg,db data
  class llm,gh,browser,mcpc ext
```

## Reading the diagram

- **Only the Ingress is public.** Every other box is reachable only through NetworkPolicies that allow specific callers: woo-mcp accepts the gateway only, MariaDB accepts WordPress only.
- **Every tool call goes through the gateway's `callTool()`**, from the browser chat and from external MCP clients. It checks permissions, applies the rate limit and timeout, calls the upstream and writes the audit row.
- **Upstream credentials are held by the gateway** (encrypted in Postgres). Clients never see them, and client tokens are never forwarded.
- **The gateway never talks to Kubernetes.** It writes desired state to Postgres, and the provisioner (the only component with cluster access) installs stores and hosted servers.
- Dotted lines are the on-demand paths (extra stores and hosted servers).
