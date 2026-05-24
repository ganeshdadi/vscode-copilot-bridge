#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3333}"
MODEL="${MODEL:-gpt-4o-mini}"

echo "== 1) Health =="
curl -sS -i "${BASE_URL}/health"
echo
echo

echo "== 2) Capabilities =="
curl -sS -i "${BASE_URL}/v1/capabilities"
echo
echo

echo "== 3) Responses non-stream =="
curl -sS -i \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"input\":\"Reply with exactly: RESPONSES_OK\"}" \
  "${BASE_URL}/v1/responses"
echo
echo

echo "== 4) Responses stream (text) =="
curl -sS -N \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"stream\":true,\"input\":\"Reply with exactly: STREAM_OK\"}" \
  "${BASE_URL}/v1/responses"
echo
echo

echo "== 5) Responses stream (tool call required) =="
curl -sS -N \
  -H "Content-Type: application/json" \
  -d "{
    \"model\":\"${MODEL}\",
    \"stream\":true,
    \"input\":\"Use the tool to get weather for Bengaluru. Do not answer without tool.\",
    \"tool_choice\":\"required\",
    \"tools\":[
      {
        \"type\":\"function\",
        \"function\":{
          \"name\":\"get_weather\",
          \"description\":\"Get weather by city\",
          \"parameters\":{
            \"type\":\"object\",
            \"properties\":{\"city\":{\"type\":\"string\"}},
            \"required\":[\"city\"]
          }
        }
      }
    ]
  }" \
  "${BASE_URL}/v1/responses"
echo
echo

echo "== 6) Chat completions still works =="
curl -sS -i \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: CHAT_OK\"}]}" \
  "${BASE_URL}/v1/chat/completions"
echo
echo
