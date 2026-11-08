const fullSha = /^[a-f0-9]{40}$/;
const outcome = /<!--\s*robin-outcome:\s*v1\s+(reviewed|reused|skipped|incomplete)\s+head=([a-f0-9]{40})(?:\s+high=\d+\s+medium=\d+\s+low=\d+\s+suggestions=\d+)?\s*-->/g;

export function reviewNumber(value) {
    const text = String(value ?? '');
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('Robin requires a positive pull request number.');
    return Number(text);
}

export function reviewHead(value) {
    if (typeof value !== 'string' || !fullSha.test(value)) throw new Error('Robin requires a full lowercase head SHA.');
    return value;
}

export function isReviewCommand(body) {
    return typeof body === 'string' && /^\/robin(?:\s|$)/.test(body);
}

export function eligiblePullRequest(pr, repository, expectedHead) {
    if (pr.state !== 'open' || pr.draft || pr.base?.ref !== 'main' ||
        pr.base?.repo?.full_name !== repository || pr.head?.repo?.full_name !== repository) {
        return {eligible: false, reason: 'ineligible-target'};
    }
    const head = reviewHead(pr.head.sha);
    if (expectedHead && head !== expectedHead) return {eligible: false, reason: 'stale-head'};
    return {eligible: true, head, pr: reviewNumber(pr.number)};
}

export function hasCompleteReceipt(reviews, head) {
    return reviews.some(review => {
        if (review.user?.login !== 'github-actions[bot]' || review.user?.type !== 'Bot' || review.commit_id !== head) return false;
        const marker = [...String(review.body ?? '').matchAll(outcome)].at(-1);
        return marker?.[2] === head && marker[1] !== 'incomplete';
    });
}

/** After this many reviewed heads another round rarely finds anything new: step back and rethink the approach. */
export const MAX_REVIEW_ROUNDS = 3;

export function completedRounds(reviews) {
    const heads = new Set();
    for (const review of reviews) {
        if (review.user?.login !== 'github-actions[bot]' || review.user?.type !== 'Bot') continue;
        const marker = [...String(review.body ?? '').matchAll(outcome)].at(-1);
        if (marker?.[1] === 'reviewed') heads.add(marker[2]);
    }
    return heads.size;
}

export async function prepareReview({github, context, expectedHead, prNumber}) {
    const repo = context.repo;
    const repository = `${repo.owner}/${repo.repo}`;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid Robin repository context.');
    let number;
    let expected;
    if (context.eventName === 'issue_comment') {
        if (!context.payload.issue?.pull_request || !isReviewCommand(context.payload.comment?.body)) return {eligible: false, reason: 'not-review-command'};
        const actor = context.payload.comment?.user?.login;
        if (typeof actor !== 'string' || !actor) throw new Error('Missing review command actor.');
        const {data} = await github.rest.repos.getCollaboratorPermissionLevel({...repo, username: actor});
        if (!['write', 'maintain', 'admin'].includes(data.permission)) throw new Error('Robin command requires repository write permission.');
        number = reviewNumber(context.payload.issue.number);
    } else if (context.eventName === 'pull_request_target') {
        number = reviewNumber(prNumber ?? context.payload.pull_request?.number);
        expected = reviewHead(expectedHead ?? context.payload.pull_request?.head?.sha);
    } else if (context.eventName === 'workflow_dispatch') {
        if (context.ref !== 'refs/heads/main') throw new Error('Robin dispatch requires main.');
        number = reviewNumber(prNumber ?? context.payload.inputs?.pr);
        expected = reviewHead(expectedHead ?? context.payload.inputs?.head);
    } else {
        throw new Error('Unsupported Robin trigger.');
    }
    const {data: pr} = await github.rest.pulls.get({...repo, pull_number: number});
    const target = eligiblePullRequest(pr, repository, expected);
    if (!target.eligible) return target;
    const dispatch = async () => {
        await github.rest.actions.createWorkflowDispatch({...repo, workflow_id: 'robin.yml', ref: 'main', inputs: {pr: String(target.pr), head: target.head}});
        return {eligible: false, reason: 'dispatched', pr: target.pr, head: target.head};
    };
    if (context.eventName === 'issue_comment') return dispatch();
    const reviews = await github.paginate(github.rest.pulls.listReviews, {...repo, pull_number: number, per_page: 100});
    if (hasCompleteReceipt(reviews, target.head)) return {...target, eligible: false, reason: 'already-covered'};
    // PR events re-enter as a main dispatch: the runner admits only immutable main
    // workflow sources, and a PR's recorded base SHA goes stale (ready_for_review).
    if (context.eventName === 'pull_request_target') return dispatch();
    if (completedRounds(reviews) >= MAX_REVIEW_ROUNDS) return {...target, eligible: false, reason: 'round-cap'};
    return {...target, reason: 'review-required'};
}
