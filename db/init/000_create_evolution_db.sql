-- ============================================================================
-- Create a separate database for Evolution API
-- ============================================================================
-- Evolution API uses Prisma which requires full ownership of its schema.
-- It cannot share a database with n8n/app tables.
-- This script runs before 001_schema.sql (alphabetical order).
-- ============================================================================

CREATE DATABASE evolution_api;
GRANT ALL PRIVILEGES ON DATABASE evolution_api TO autoshare;
