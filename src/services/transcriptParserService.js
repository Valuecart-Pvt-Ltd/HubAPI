// ─── Category heuristics ─────────────────────────────────────────────────────

const CATEGORY_RULES = [
  { keywords: /\b(bug|fix|defect|issue|error|crash|patch)\b/i,               category: 'Bug Fix'        },
  { keywords: /\b(deploy|release|launch|ship|rollout|go.?live)\b/i,          category: 'Deployment'     },
  { keywords: /\b(design|ui|ux|figma|mockup|wireframe|prototype)\b/i,        category: 'Design'         },
  { keywords: /\b(test|qa|quality|coverage|spec|e2e)\b/i,                    category: 'QA / Testing'   },
  { keywords: /\b(doc|documentation|readme|wiki|runbook|guide)\b/i,          category: 'Documentation'  },
  { keywords: /\b(review|pr|pull.?request|approve|merge|code.?review)\b/i,   category: 'Code Review'    },
  { keywords: /\b(infra|infrastructure|devops|ci|cd|pipeline|k8s|aws|gcp)\b/i, category: 'Infrastructure' },
  { keywords: /\b(meeting|follow.?up|sync|call|standup)\b/i,                 category: 'Follow-up'      },
  { keywords: /\b(report|analytics|metrics|dashboard|kpi)\b/i,               category: 'Reporting'      },
  { keywords: /\b(budget|cost|invoice|payment|finance|billing)\b/i,          category: 'Finance'        },
  { keywords: /\b(hire|recruit|onboard|interview|headcount)\b/i,             category: 'HR'             },
  { keywords: /\b(marketing|campaign|seo|social|ads|content)\b/i,            category: 'Marketing'      },
]

function inferCategory(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.test(text)) return rule.category
  }
  return 'General'
}

function resolveEmail(assignee, participants) {
  if (!assignee) return null

  const lower = assignee.toLowerCase().trim()

  const byEmail = participants.find((p) => p.email.toLowerCase() === lower)
  if (byEmail) return byEmail.email

  const byName = participants.find(
    (p) =>
      p.name.toLowerCase().includes(lower) ||
      lower.includes(p.name.toLowerCase()),
  )
  if (byName) return byName.email

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) return lower

  return null
}

function parseReadAI(payload) {
  if (!payload.meetingTitle || !payload.startTime) {
    throw new Error('Read AI payload missing required fields: meetingTitle, startTime')
  }

  const participants  = Array.isArray(payload.participants)  ? payload.participants  : []
  const actionItems   = Array.isArray(payload.actionItems)   ? payload.actionItems   : []

  const participantMap = participants.map((p) => ({
    name:  p.name  || '',
    email: p.email || '',
  }))

  const items = actionItems.map((item) => {
    const ownerEmail = resolveEmail(item.assignee, participantMap)
    return {
      action_item: (item.text || '').trim(),
      owner_email: ownerEmail,
      owner_name:  item.assignee || null,
      eta:         item.dueDate  || null,
      category:    inferCategory(item.text || ''),
      status:      'pending',
    }
  })

  return {
    title:     payload.meetingTitle,
    startTime: payload.startTime,
    attendees: participants.map((p) => p.email).filter(Boolean),
    items,
  }
}

function parseFireflies(payload) {
  const { transcript } = payload

  const participantMap = (transcript.participants || []).map((p) => ({
    name:  p.displayName,
    email: p.email,
  }))

  const rawItems = []

  if (transcript.tasks && transcript.tasks.length > 0) {
    rawItems.push(...transcript.tasks)
  } else if (transcript.summary?.action_items) {
    const lines = transcript.summary.action_items
      .split('\n')
      .map((l) => l.replace(/^[\s\-•*\d.]+/, '').trim())
      .filter((l) => l.length > 0)
    rawItems.push(...lines.map((l) => ({ text: l })))
  }

  const items = rawItems.map((item) => {
    const ownerEmail = resolveEmail(item.assignee, participantMap)
    return {
      action_item: (item.text || '').trim(),
      owner_email: ownerEmail,
      owner_name:  item.assignee || null,
      eta:         item.due_date || null,
      category:    inferCategory(item.text || ''),
      status:      'pending',
    }
  })

  return {
    title:     transcript.title,
    startTime: transcript.date,
    attendees: participantMap.map((p) => p.email).filter(Boolean),
    items,
  }
}

function normalizeItems(items) {
  const seen = new Set()
  return items
    .filter((item) => item.action_item.length > 0)
    .filter((item) => {
      const key = item.action_item.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

module.exports = { parseReadAI, parseFireflies, normalizeItems }
