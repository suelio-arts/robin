const fullSha = /^[a-f0-9]{40}$/;

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
    if (context.eventName === 'workflow_dispatch') return {...target, reason: 'review-required'};
    await github.rest.actions.createWorkflowDispatch({...repo, workflow_id: 'robin.yml', ref: 'main', inputs: {pr: String(target.pr), head: target.head}});
    return {eligible: false, reason: 'dispatched', pr: target.pr, head: target.head};
}
