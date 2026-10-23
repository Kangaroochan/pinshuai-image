// Prompt guidance, not an image API strength parameter or similarity score.
export const DEPTH_PROFILES = [
  { level: 1, name: '轻微调整', scope: 'Keep the location, camera viewpoint and main product arrangement close to the source. Adjust a small amount of ambient light or secondary background detail.' },
  { level: 2, name: '局部微调', scope: 'Keep the main scene and composition recognizable. Reposition minor accessories and gently adjust lighting or background styling.' },
  { level: 3, name: '轻度重构', scope: 'Keep the same scene category and usage moment. Refresh surface or background details and modestly change accessory arrangement or camera position.' },
  { level: 4, name: '适度重构', scope: 'Make a clearly fresh shot within a similar setting. Adjust camera viewpoint, product layout and surrounding materials while retaining familiar scene cues.' },
  { level: 5, name: '平衡重构', scope: 'Create a balanced new photograph: redesign setting or background, camera viewpoint and product arrangement coherently. Keep the same product story and believable use.' },
  { level: 6, name: '明显重构', scope: 'Make substantial coordinated changes to setting, camera viewpoint, product and accessory placement, and lighting. Refresh relevant human gestures without changing actual product use.' },
  { level: 7, name: '深度重构', scope: 'Build a distinctly new scene and spatial layout. Strongly rework viewpoint, framing, background, light and relevant human interaction around the same products and use case.' },
  { level: 8, name: '全面重拍', scope: 'Treat the source as product evidence for a new shoot. Rebuild most flexible scene, composition, light and interaction choices while preserving product truth and the original purpose.' },
  { level: 9, name: '创意重构', scope: 'Develop a substantially new visual presentation and a fresh plausible moment within the same real use case. Rebuild flexible visual choices rather than inheriting the original layout.' },
  { level: 10, name: '最大重构', scope: 'Use the greatest coherent scene and composition freedom allowed by the brief. Reconsider all unlocked visual dimensions, retaining source product identity, counts, details, copy and truthful usage. Do not maximize arbitrary changes or introduce implausible props.' },
];

// Depth changes expression variation within the source emotional tone, never its direction.
const EXPRESSION_GUIDANCE = [
  'Keep the source emotional tone; make only a tiny adjustment to eye focus or mouth relaxation within that tone.',
  'Keep the source emotional tone; subtly adjust gaze, eyelids or mouth corners for a fresh captured moment within that tone.',
  'Keep the source emotional tone; make a mild visible variation in gaze and mouth, such as a slightly different smile when the source is smiling.',
  'Keep the source emotional tone; coordinate visibly different eyes, brows and mouth within that tone, without changing emotional direction.',
  'Keep the source emotional tone; plan an observable new expression suited to the activity, varying gaze, brows and mouth within that tone.',
  'Keep the source emotional tone; noticeably redesign the expression and its timing within that tone while preserving truthful product use.',
  'Keep the source emotional tone; choose a distinctly different expression variant within that tone, with coordinated gaze and interaction.',
  'Keep the source emotional tone; rebuild gaze, eyes, brows and mouth around the new interaction, using a broader natural variation within that tone.',
  'Keep the source emotional tone; freely re-plan the facial response and timing within that tone, preserving the original emotional direction.',
  'Keep the source emotional tone; use the fullest permitted variation of gaze, eyes, brows and mouth within that tone. A smile may become a different natural smile, not crying, sadness or anger. Depth never authorizes an emotional reversal or forced exaggeration.',
];

export function applyReconstruction(input, cliDepth) {
  if (input.reconstruction !== undefined && (!input.reconstruction || typeof input.reconstruction !== 'object' || Array.isArray(input.reconstruction))) throw new Error('reconstruction must be an object.');
  const declared = input.reconstruction?.level;
  if (declared !== undefined && (!Number.isInteger(declared) || declared < 1 || declared > 10)) throw new Error('reconstruction.level must be an integer from 1 to 10.');
  if (cliDepth !== undefined && !/^(?:[1-9]|10)$/.test(cliDepth)) throw new Error('--depth must be an integer from 1 to 10.');
  const level = cliDepth !== undefined ? Number(cliDepth) : declared ?? 5;
  if (cliDepth !== undefined && declared !== undefined && declared !== level) throw new Error('--depth conflicts with reconstruction.level. Align the prompt plan with the requested depth before submitting.');
  const profile = DEPTH_PROFILES[level - 1];
  return {
    ...input,
    reconstruction: {
      ...input.reconstruction,
      level,
      profile: profile.name,
      scope: profile.scope,
      interpretation: 'An ordinal prompt-guidance level for scene and composition changes. Not an API denoise/strength parameter, percentage, measured similarity or platform duplicate-check score.',
      priority: 'Explicit user locks and factual product invariants take priority over this profile. Choose coordinated changes only on unlocked, applicable axes. If locks prevent the requested degree, state that limitation instead of changing products.',
      invariants: 'At every level retain product identity, count, pattern, geometry, visible structures, colors, relative scale, packaging, essential accessories, exact advertising wording and emojis unless the user explicitly requests changes to those specific items. Depth alone never authorizes such changes.',
      human_expression: {
        depth_guidance: EXPRESSION_GUIDANCE[level - 1],
        emotional_tone_rule: 'By default preserve the source emotional tone at every depth, including 10. Depth controls only expression variation within the same tone. Change emotional direction only when the user explicitly requests it; scene redesign, a high depth or changing identity is not that authorization. If the source emotion is ambiguous, describe visible cues and keep it conservative rather than inventing an emotional reversal.',
        planning: 'For a visible human face, describe source emotional tone and visible cues, a concrete target expression within that tone, and changes to gaze, eyebrows, eyes and mouth. Low levels make subtle variations; high levels allow broader natural variations within the same tone, not stronger or exaggerated emotion. Record any explicit user request to change the tone separately; do not infer it from depth.',
        priority: 'An explicit user expression/emotion lock overrides this guidance. Identity preservation alone does not freeze expression: keep the same recognizable person while changing only the permitted expression. Respect all user locks, scene context and truthful product usage. Preserve the source emotional tone unless an explicit user instruction changes it; that instruction takes priority over the default same-tone examples in depth_guidance.',
        applicability: 'Only visible human faces; with no person, hands-only or a back view mark not applicable and do not invent a face. Keep facial anatomy plausible. Preserve product character faces, printed expressions and advertising emojis unchanged unless explicitly requested otherwise.',
      },
      human_appearance: {
        scope: 'Only unlocked human scene participants; preserve identity for portrait subjects and user-locked people. Faces or characters on products are product details, never recast them.',
        depth_guidance: level <= 2
          ? 'Subtle expression and hair details; retain recognizable original facial features.'
          : level <= 4
            ? 'Moderate hairstyle, hair color, makeup and expression changes; avoid unrelated identity replacement.'
            : level <= 6
              ? 'For each unlocked visible face, plan a recognizable new fictional identity by specifying at least three changed identity-bearing facial features: face shape, eye shape or spacing, eyebrow shape, nose shape, lip shape, jaw or cheek structure. Describe hair, clothing and expression separately; those styling changes do not count toward the facial-feature minimum. Keep the broad age range and usage role unless the user says otherwise.'
              : level <= 8
                ? 'For each unlocked visible face, use a clearly different fictional identity and specify at least four changed identity-bearing facial features: face shape, eye shape or spacing, eyebrow shape, nose shape, lip shape, jaw or cheek structure. Describe hair, clothing and expression separately; those styling changes do not count toward the facial-feature minimum. Keep the broad age range and usage role unless explicitly changed.'
                : 'Recast each unlocked visible participant with a clearly different fictional identity and specify at least four changed identity-bearing facial features per person: face shape, eye shape or spacing, eyebrow shape, nose shape, lip shape, jaw or cheek structure. Describe hair, clothing and expression separately; those styling changes do not count toward the facial-feature minimum. Retain original roles, person count and broad age range unless explicitly changed, and respect every user lock.',
        minimum_face_identity_changes: level <= 4 ? 0 : level <= 6 ? 3 : 4,
        planning: 'For every planned output, write a concrete cast profile for each unlocked visible person. If the source is a scene reference and the user has not locked identity, treat its people as pose, role and layout references only; explicitly do not preserve their facial identities. Give each output a different cast profile. Never count expression, makeup intensity, hair color or clothing alone as a facial identity change.',
        batch_cast_plan: input.human_presence?.batch_person_allocation ?? null,
        applicable_only: 'No new people if the source/brief has none. With hands-only or back views, change visible aspects only; do not invent a visible face. Keep person count, anatomical plausibility and product scale. Explicit identity locks override all depth guidance; a higher level never changes faces printed on products.',
      },
      content_rules: 'Preserve truthful product usage. Extra props must not imply included merchandise. At low levels, subtle edits are intentional. At higher levels, create actual scene and composition changes rather than merely cropping, mirroring, recoloring or blurring.',
    },
  };
}
