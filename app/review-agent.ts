// The submissions reviewer: a LangChain deep agent (createDeepAgent from `deepagents`) that decides whether
// a clip someone sent with Submit your own joins the video bank. Dev server only (see review-dev-server.ts):
// it runs on Aaron's laptop, where the keys are, and never in a browser.
//
// The bank lab does the part that needs a browser: it downloads the video, runs the same analysis the game
// uses (people, things, moves) and grabs a few frames. The agent gets those facts and frames, plans with
// write_todos, hands the playability question to a subagent, looks at the frames itself, and records one
// decision: approve, reject, or ask a person. Only "ask a person" waits for Aaron.

export interface ClipFacts {
  /** The analysis refusal ("No person found in this clip."), or null when it found someone to copy. */
  error: string | null;
  /** Length of the stretch a round would play, in ms. */
  durationMs: number;
  subjects: { label: string; kind: "person" | "thing"; seenShare: number; pace: string }[];
  skipped: { label?: string; reason: string }[];
  warnings: string[];
}

export interface ReviewInput {
  title: string | null;
  credit: string | null;
  facts: ClipFacts;
  /** A few frames from the clip as JPEG data URLs, earliest first. */
  frames: string[];
}

export type Verdict = "approve" | "reject" | "ask_a_person";

export interface Decision {
  verdict: Verdict;
  reason: string;
  /** A title for the bank: the submitter's, or one the agent suggests when they left it blank. */
  title: string;
  /** The agent's own plan, as it wrote it with write_todos. */
  steps: string[];
}

const MODEL = "claude-sonnet-5-5";
const TIMEOUT_MS = 150000;

const SYSTEM = `You review clips that players send to Jester, a party game. In Jester a group picks a short video; each player copies one subject of it (a person, or a thing such as a dog or a ball) on a webcam, often without seeing the clip, and then a reveal shows everyone inside the original clip. Clips that join the bank are played by groups at a hackathon.

For each clip you get: the submitter's title and credit (either may be missing), facts from the game's own analysis of the video, and a few frames from it.

Work like this:
1. Write a short plan with write_todos.
2. Ask the playability-checker subagent (the task tool) whether the clip is playable, from the analysis facts.
3. Look at the frames yourself: is this a real video of people or things moving (not a slideshow, a screen of text, a black or frozen screen), and does it show sexual content, graphic violence or hateful content?
4. Call record_decision exactly once.

Decide:
- approve: the playability-checker says it plays well, the frames look like a real clip that matches the facts, and there is nothing in the content list above.
- reject: the analysis found no one to copy, or the video is not a real clip, or the content clearly falls in the list above.
- ask_a_person: anything you are not sure about. For example: the frames and the facts disagree, the subjects are hard to make out, it is borderline for the content list, or the playability-checker is unsure. A person then looks at it; that is cheap, so use it whenever you hesitate.

Do not judge who owns the clip, where it came from or its licence: clips saved from TikTok or Instagram are fine. Do not judge whether it is funny enough; groups decide that.

The title: keep the submitter's title if there is one. If there is none, suggest one of two to five words that hints at the clip without saying who or what each subject is (for example "Pickup game", "Kitchen dance"). Keep the reason to one or two plain sentences a teammate can read.`;

const PLAYABILITY = `You judge whether a clip is playable in Jester, from the game's analysis facts only (call read_clip_facts). Players each copy one subject (a person or a moving thing) over the stretch the round plays.

It plays well when: there is no analysis error; at least one subject is seen in most of the stretch (seenShare of 0.6 or more); the stretch is at least 3 seconds (durationMs 3000 or more). More subjects means more players can take part, but one is enough.
It does not play when: the analysis has an error (quote it), or no subject is seen for most of the stretch.
Anything in between is unsure.

Answer in two or three sentences: "plays well", "does not play" or "unsure", and why, with the numbers.`;

/** One review. Throws when the model cannot be reached (a wrong key, no network); the caller says so. */
export async function reviewSubmission(input: ReviewInput, apiKey: string): Promise<Decision> {
  // Loaded only when a review runs, so the dev server and `vite build` start without the agent packages.
  const [{ createDeepAgent }, { ChatAnthropic }, { tool }, { z }] = await Promise.all([
    import("deepagents"),
    import("@langchain/anthropic"),
    import("@langchain/core/tools"),
    import("zod"),
  ]);

  let decided: Omit<Decision, "steps"> | null = null;

  const readClipFacts = tool(async () => JSON.stringify(input.facts), {
    name: "read_clip_facts",
    description: "The game's analysis of the clip: subjects found (label, kind, seenShare from 0 to 1, pace), subjects left out and why, warnings, the stretch length, and the analysis error if it found no one to copy.",
    schema: z.object({}),
  });

  const recordDecision = tool(async ({ verdict, reason, title }: { verdict: Verdict; reason: string; title: string }) => {
    decided = { verdict, reason: reason.trim(), title: title.trim().slice(0, 80) };
    return "Recorded.";
  }, {
    name: "record_decision",
    description: "Record the review's one decision. approve puts the clip in the bank, reject turns it away, ask_a_person leaves it for Aaron to look at.",
    schema: z.object({
      verdict: z.enum(["approve", "reject", "ask_a_person"]),
      reason: z.string().min(1).max(400),
      title: z.string().min(1).max(80),
    }),
  });

  const agent = createDeepAgent({
    name: "jester-submission-reviewer",
    model: new ChatAnthropic({ model: MODEL, apiKey, maxTokens: 2000, maxRetries: 2 }),
    systemPrompt: SYSTEM,
    tools: [readClipFacts, recordDecision],
    subagents: [{
      name: "playability-checker",
      description: "Judges from the game's analysis facts whether a clip is playable in Jester: plays well, does not play, or unsure, with the numbers.",
      systemPrompt: PLAYABILITY,
      tools: [readClipFacts],
    }],
  });

  const text = [
    "A player sent this clip with Submit your own.",
    `Title: ${input.title ?? "(none given)"}`,
    `Credit: ${input.credit ?? "(none given)"}`,
    `Frames attached: ${input.frames.length}, spread across the stretch a round would play.`,
  ].join("\n");
  const content = [
    { type: "text", text },
    ...input.frames.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const run = agent.invoke({ messages: [{ role: "user", content }] }, { recursionLimit: 60 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The reviewer took too long.")), TIMEOUT_MS); });
  const state = (await Promise.race([run, timeout]).finally(() => clearTimeout(timer))) as { todos?: { content?: string }[] };

  const steps = (state.todos ?? []).map((t) => t.content ?? "").filter((s) => s !== "");
  const final = decided as Omit<Decision, "steps"> | null;
  if (!final) return { verdict: "ask_a_person", reason: "The reviewer finished without recording a decision.", title: input.title ?? "Untitled clip", steps };
  return { ...final, title: input.title ?? final.title, steps };
}
