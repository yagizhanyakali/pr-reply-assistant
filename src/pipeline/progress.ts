/**
 * Translates internal pipeline log lines into user-facing toast messages.
 * Trim to ~90 chars to fit VS Code's progress notification width.
 */
export function humanizeProgressMessage(line: string): string {
	const max = 90;
	const trim = (s: string): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
	const lower = line.toLowerCase();

	const toolMatch = line.match(/^Tool:\s*([A-Za-z_]+)\(([^)]*)\)/);
	if (toolMatch) {
		const [, tool, args] = toolMatch;
		const argsShort = args.length > 50 ? `${args.slice(0, 50)}…` : args;
		return trim(toolFriendlyMessage(tool, argsShort));
	}

	const plannerRoundMatch = line.match(/^Planner round (\d+)\/(\d+):/);
	if (plannerRoundMatch) {
		const [, current, total] = plannerRoundMatch;
		if (line.includes('thinking')) {
			return trim(`Planning evidence (round ${current}/${total})…`);
		}
		if (line.includes('calling')) {
			const tools = line.split('calling').pop()?.replace(/…$/, '').trim() ?? '';
			return trim(`Round ${current}/${total}: ${tools}`);
		}
		if (line.includes('finished')) {
			return trim(`Planner finished (round ${current}/${total}).`);
		}
		return trim(line);
	}

	if (lower.startsWith('pipeline: starting contextplanner pass 1')) {
		return 'Planning what code to inspect…';
	}
	if (lower.startsWith('planner pass 1 done')) {
		return trim(`Initial evidence gathered. ${extractAfterColon(line)}`);
	}
	if (lower.startsWith('planner pass 2 starting')) {
		return 'Critic asked for more evidence — fetching…';
	}
	if (lower.startsWith('planner pass 2 done')) {
		return 'Additional evidence gathered.';
	}
	if (lower.startsWith('decider:')) {
		return trim(`Decider: ${extractAfterColon(line)}`);
	}
	if (lower.startsWith('critic pass 1:')) {
		return 'Critic reviewing the verdict…';
	}
	if (lower.startsWith('critic pass 2:')) {
		return 'Critic refining with new evidence…';
	}
	if (lower.startsWith('arbiter:')) {
		if (lower.includes('stripped')) {
			return 'Polishing reply (stripped trailing questions)…';
		}
		return 'Drafting final reply…';
	}
	if (lower.startsWith('anchor:')) {
		return trim(line.replace(/^anchor:\s*/i, 'Anchor: '));
	}
	if (lower.startsWith('depth:')) {
		return 'Pre-seeding deep PR context…';
	}
	if (lower.startsWith('model:')) {
		return trim(line);
	}
	return trim(line);
}

function toolFriendlyMessage(tool: string, argsShort: string): string {
	switch (tool) {
		case 'read_file_range':
		case 'read_full_file':
			return `Reading code: ${argsShort}`;
		case 'code_context_around_comment':
			return 'Reading code around the comment…';
		case 'symbol_evidence_around_comment':
			return 'Inspecting symbols near the comment…';
		case 'pr_diff_stat':
			return 'Reading available change summary…';
		case 'pr_full_diff':
			return 'Reading available change diff…';
		case 'file_diff':
			return `Reading file diff: ${argsShort}`;
		case 'find_references':
			return `Finding references: ${argsShort}`;
		case 'workspace_symbol_search':
			return `Searching workspace symbols: ${argsShort}`;
		case 'grep_workspace':
			return `Grepping workspace: ${argsShort}`;
		case 'git_log':
			return `Reading git log: ${argsShort}`;
		case 'git_blame':
			return `Reading git blame: ${argsShort}`;
		case 'deep_context':
			return 'Gathering deep context…';
		case 'comprehensive_context_around_comment':
			return 'Gathering comprehensive context…';
		case 'web_search':
			return `Web search: ${argsShort}`;
		default:
			return `Calling ${tool}…`;
	}
}

function extractAfterColon(line: string): string {
	const idx = line.indexOf(':');
	if (idx < 0) {
		return line;
	}
	return line.slice(idx + 1).trim();
}
