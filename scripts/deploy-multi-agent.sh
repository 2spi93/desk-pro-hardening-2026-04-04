#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# MULTI-AGENT SYSTEM - DEPLOYMENT CHECKLIST
# ═══════════════════════════════════════════════════════════════════════════

set -e  # Exit on any error

echo "🚀 MULTI-AGENT SYSTEM DEPLOYMENT CHECKLIST"
echo "=========================================="
echo ""

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

STEP=0
ERRORS=0

# Helper function
check() {
    STEP=$((STEP + 1))
    echo -e "${BLUE}[Step $STEP]${NC} $1"
}

pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1\n"
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ERRORS=$((ERRORS + 1))
    echo ""
}

warn() {
    echo -e "${YELLOW}⚠ WARN${NC}: $1\n"
}

# ═══════════════════════════════════════════════════════════════════════════
# Phase 1: Verify Files
# ═══════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}PHASE 1: VERIFY FILES${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

check "Agent framework file exists"
if [ -f "/opt/txt/apps/ai_orchestrator/agents_framework.py" ]; then
    pass "agents_framework.py found"
else
    fail "agents_framework.py NOT found at /opt/txt/apps/ai_orchestrator/"
fi

check "Specialized agents file exists"
if [ -f "/opt/txt/apps/ai_orchestrator/agents_specialized.py" ]; then
    pass "agents_specialized.py found"
else
    fail "agents_specialized.py NOT found at /opt/txt/apps/ai_orchestrator/"
fi

check "Multi-agent router file exists"
if [ -f "/opt/txt/apps/ai_orchestrator/multi_agent_router.py" ]; then
    pass "multi_agent_router.py found"
else
    fail "multi_agent_router.py NOT found at /opt/txt/apps/ai_orchestrator/"
fi

check "Documentation files exist"
if [ -f "/opt/txt/MULTI_AGENT_COMPLETE_GUIDE.md" ] && \
   [ -f "/opt/txt/MULTI_AGENT_QUICKSTART.md" ] && \
   [ -f "/opt/txt/MULTI_AGENT_INTEGRATION_PATCH.py" ]; then
    pass "All documentation files found"
else
    fail "Some documentation files missing"
fi

check "Test script exists"
if [ -f "/opt/txt/scripts/test-multi-agent.sh" ]; then
    pass "test-multi-agent.sh found"
    chmod +x /opt/txt/scripts/test-multi-agent.sh
    pass "test-multi-agent.sh made executable"
else
    fail "test-multi-agent.sh NOT found"
fi

check "Database migration exists"
if [ -f "/opt/txt/database/migrations/008_multi_agent_schema.sql" ]; then
    pass "008_multi_agent_schema.sql found"
else
    fail "Database migration NOT found"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Phase 2: Verify Python Syntax
# ═══════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}PHASE 2: VERIFY PYTHON SYNTAX${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

check "agents_framework.py syntax"
if python3 -m py_compile /opt/txt/apps/ai_orchestrator/agents_framework.py 2>/dev/null; then
    pass "agents_framework.py syntax valid"
else
    fail "agents_framework.py has syntax errors"
fi

check "agents_specialized.py syntax"
if python3 -m py_compile /opt/txt/apps/ai_orchestrator/agents_specialized.py 2>/dev/null; then
    pass "agents_specialized.py syntax valid"
else
    fail "agents_specialized.py has syntax errors"
fi

check "multi_agent_router.py syntax"
if python3 -m py_compile /opt/txt/apps/ai_orchestrator/multi_agent_router.py 2>/dev/null; then
    pass "multi_agent_router.py syntax valid"
else
    fail "multi_agent_router.py has syntax errors"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Phase 3: Verify Dependencies
# ═══════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}PHASE 3: VERIFY DEPENDENCIES${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

check "FastAPI installed"
if python3 -c "import fastapi" 2>/dev/null; then
    pass "FastAPI available"
else
    fail "FastAPI NOT installed"
fi

check "Pydantic installed"
if python3 -c "import pydantic" 2>/dev/null; then
    pass "Pydantic available"
else
    fail "Pydantic NOT installed"
fi

check "httpx installed"
if python3 -c "import httpx" 2>/dev/null; then
    pass "httpx available"
else
    warn "httpx NOT installed (optional, for async requests)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Phase 4: Control Plane Integration Check
# ═══════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}PHASE 4: CONTROL PLANE INTEGRATION${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

check "Control plane main.py exists"
if [ -f "/opt/txt/apps/control_plane/main.py" ]; then
    pass "control_plane/main.py found"
    
    check "Multi-agent import in control plane"
    if grep -q "multi_agent_router" /opt/txt/apps/control_plane/main.py; then
        pass "multi_agent_router import found"
    else
        warn "multi_agent_router import NOT found (needs manual integration)"
    fi
    
    check "Multi-agent router mounted"
    if grep -q "app.include_router(multi_agent_router" /opt/txt/apps/control_plane/main.py; then
        pass "Router mount found"
    else
        warn "Router mount NOT found (needs manual integration)"
    fi
else
    fail "control_plane/main.py NOT found"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Phase 5: Database Schema
# ═══════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}PHASE 5: DATABASE SCHEMA${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

check "Database migrations directory"
if [ -d "/opt/txt/database/migrations" ]; then
    pass "migrations directory exists"
    
    check "SQL migration file"
    if [ -f "/opt/txt/database/migrations/008_multi_agent_schema.sql" ]; then
        pass "008_multi_agent_schema.sql found"
        warn "TODO: Run this SQL file against your database manually"
    else
        fail "SQL migration NOT found"
    fi
else
    fail "migrations directory NOT found"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Phase 6: Manual Steps
# ═══════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}PHASE 6: MANUAL SETUP REQUIRED${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

warn "The following steps must be done manually:"
echo ""
echo "1. INTEGRATE WITH CONTROL PLANE:"
echo "   Edit /opt/txt/apps/control_plane/main.py and add:"
echo "   ---"
echo "   from multi_agent_router import router as multi_agent_router"
echo "   app.include_router(multi_agent_router, prefix=\"/api\")"
echo "   ---"
echo ""

echo "2. CREATE DATABASE TABLES:"
echo "   mysql -h your_db_host -u user -p < /opt/txt/database/migrations/008_multi_agent_schema.sql"
echo ""

echo "3. RESTART CONTROL PLANE:"
echo "   docker-compose restart control-plane"
echo ""

echo "4. TEST ENDPOINTS:"
echo "   ./scripts/test-multi-agent.sh http://localhost:8000"
echo ""

echo "5. MONITOR LOGS:"
echo "   docker logs -f control-plane"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Phase 7: System Test (if control plane running)
# ═══════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}PHASE 7: VERIFY RUNNING SYSTEM${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

check "Control plane health endpoint"
if nc -zv 127.0.0.1 8000 &>/dev/null; then
    if curl -s http://localhost:8000/health >/dev/null 2>&1; then
        pass "Control plane is running"
        
        check "Multi-agent health endpoint"
        if curl -s http://localhost:8000/api/v1/multi-agent/health >/dev/null 2>&1; then
            pass "Multi-agent system is active"
            
            # Get agent count
            AGENT_COUNT=$(curl -s http://localhost:8000/api/v1/multi-agent/health | grep -o '"agent_count":[0-9]*' | cut -d':' -f2)
            if [ "$AGENT_COUNT" -eq "5" ]; then
                pass "All 5 agents loaded"
            else
                warn "Expected 5 agents, found $AGENT_COUNT"
            fi
        else
            warn "Multi-agent endpoint not responding (may need restart)"
        fi
    else
        warn "Control plane health check failed"
    fi
else
    warn "Control plane not running on port 8000"
    echo "   Either:"
    echo "   - Control plane not started"
    echo "   - Running on different port"
    echo "   - Integration not complete"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Final Summary
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}DEPLOYMENT SUMMARY${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

echo -e "Steps Completed: ${GREEN}$STEP${NC}"
if [ "$ERRORS" -gt 0 ]; then
    echo -e "Errors Found: ${RED}$ERRORS${NC}"
    echo ""
    echo -e "${RED}❌ DEPLOYMENT INCOMPLETE${NC}"
    echo ""
    echo "Fix the errors above and run this script again."
    exit 1
else
    echo -e "Errors Found: ${GREEN}$ERRORS${NC}"
    echo ""
    echo -e "${GREEN}✅ ALL CHECKS PASSED${NC}"
fi

echo ""
echo "📚 DOCUMENTATION:"
echo "  - Quick Start: /opt/txt/MULTI_AGENT_QUICKSTART.md"
echo "  - Full Guide: /opt/txt/MULTI_AGENT_COMPLETE_GUIDE.md"
echo "  - Integration: /opt/txt/MULTI_AGENT_INTEGRATION_PATCH.py"
echo ""

echo "🧪 TESTING:"
echo "  Run: ./scripts/test-multi-agent.sh http://localhost:8000"
echo ""

echo "📊 MONITORING:"
echo "  WebSocket: ws://localhost:8000/api/v1/multi-agent/ws/decisions"
echo "  Agent Perf: curl http://localhost:8000/api/v1/multi-agent/agents"
echo ""

echo "✅ Next: Complete manual steps above and restart services"
echo ""

exit 0
