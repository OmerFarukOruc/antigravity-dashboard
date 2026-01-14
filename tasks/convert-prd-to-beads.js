#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read the prd.json
const prdPath = path.join(__dirname, 'prd.json');
const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));

// Map priority (1-3 in PRD) to beads priority (0-4, where 0 is highest)
// Priority 1 (highest) -> 0
// Priority 2 (medium) -> 2
// Priority 3 (low) -> 3
function mapPriority(prdPriority) {
  const priorityMap = {
    1: 0,  // High priority
    2: 2,  // Medium priority
    3: 3   // Low priority
  };
  return priorityMap[prdPriority] || 2;
}

// Convert user stories to beads issues
const beadsIssues = prd.userStories.map((story, index) => {
  const now = new Date().toISOString();

  // Build description with acceptance criteria
  let description = story.description;
  if (story.acceptanceCriteria && story.acceptanceCriteria.length > 0) {
    description += '\n\n**Acceptance Criteria:**\n';
    story.acceptanceCriteria.forEach(criterion => {
      description += `- [ ] ${criterion}\n`;
    });
  }

  // Add dependencies if present
  if (story.dependsOn && story.dependsOn.length > 0) {
    description += `\n**Dependencies:** ${story.dependsOn.join(', ')}`;
  }

  return {
    id: story.id,
    title: story.title,
    description: description.trim(),
    status: story.passes ? 'closed' : 'open',
    priority: mapPriority(story.priority),
    issue_type: 'task',
    labels: ['pnpm-migration'],
    created_at: now,
    created_by: 'prd-import',
    updated_at: now,
    blocks: story.dependsOn || []
  };
});

// Write as JSONL (one JSON object per line)
const outputPath = path.join(__dirname, 'prd-beads.jsonl');
const jsonlContent = beadsIssues.map(issue => JSON.stringify(issue)).join('\n');
fs.writeFileSync(outputPath, jsonlContent + '\n', 'utf8');

console.log(`✓ Converted ${beadsIssues.length} user stories to beads format`);
console.log(`✓ Output: ${outputPath}`);
console.log(`\nTo import into beads, run:`);
console.log(`  bd import -i tasks/prd-beads.jsonl`);
