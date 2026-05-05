import { MAX_WEB_QUERY_COUNT, MAX_WEB_SUMMARY_CHARS } from '../constants';
import { truncateText } from '../utils';

export async function fetchWebContextForDecision(params: {
	commentText: string;
	webQueries: string[];
}): Promise<string | undefined> {
	const fallbackQuery = params.commentText.split('\n')[0]?.trim().slice(0, 100);
	const queries = (params.webQueries.length ? params.webQueries : [fallbackQuery])
		.filter((query): query is string => Boolean(query))
		.slice(0, MAX_WEB_QUERY_COUNT);
	if (!queries.length) {
		return undefined;
	}

	const summaries: string[] = [];
	for (const query of queries) {
		const summary = await fetchDuckDuckGoSummary(query);
		if (summary) {
			summaries.push(`Query: ${query}\n${summary}`);
		}
	}

	if (!summaries.length) {
		return undefined;
	}
	return truncateText(
		summaries.join('\n\n'),
		MAX_WEB_SUMMARY_CHARS,
		'[Web context truncated due to length.]',
	);
}

export async function fetchDuckDuckGoSummary(query: string): Promise<string | undefined> {
	try {
		const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
		const response = await fetch(url);
		if (!response.ok) {
			return undefined;
		}
		const payload = (await response.json()) as {
			AbstractText?: string;
			AbstractURL?: string;
			Heading?: string;
			RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
		};

		if (payload.AbstractText) {
			const heading = payload.Heading ? `${payload.Heading}: ` : '';
			const source = payload.AbstractURL ? `\nSource: ${payload.AbstractURL}` : '';
			return `${heading}${payload.AbstractText}${source}`;
		}

		const related = payload.RelatedTopics?.find((item) => item.Text);
		if (related?.Text) {
			const source = related.FirstURL ? `\nSource: ${related.FirstURL}` : '';
			return `${related.Text}${source}`;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
