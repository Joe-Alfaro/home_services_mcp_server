# home_services_mcp_server

A data layer and read-only MCP server for a home-services marketplace. It ingests job data from
several differently shaped provider sources (field-service CRMs, a spreadsheet job log, calendar
feeds and provider profiles), normalizes it into one canonical model of providers, properties, jobs
and availability, and exposes it to AI agents through privacy-aware MCP tools.

Status: under construction. Setup, usage and design docs will land here as the build progresses.

## Data

The source data is not part of this repository. Setup reads it from a local folder set by an
environment variable (documented once the setup command exists).
