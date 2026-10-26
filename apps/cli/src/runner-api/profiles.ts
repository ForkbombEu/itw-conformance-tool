import { z } from 'zod';

const profileSchema = z
  .object({
    allowedScenarioIds: z.array(z.string().min(1)).min(1),
    category: z.enum(['issuance', 'presentation']),
    configPath: z.string().min(1),
    coverageMode: z.enum(['interoperability', 'it_wallet_profile']),
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    initializedAssetsDir: z.string().optional(),
    publicOrigins: z.array(z.string().url()).optional()
  })
  .strict();

export type Profile = z.infer<typeof profileSchema>;

export class ProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

export function validateProfile(raw: unknown): Profile {
  const result = profileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ProfileError('INVALID_PROFILE', `Invalid profile: ${issues}`);
  }
  return result.data;
}

export function assertSelectionAllowed(profile: Profile, scenarioIds: string[]): void {
  for (const id of scenarioIds) {
    if (!profile.allowedScenarioIds.includes(id)) {
      throw new ProfileError('SELECTION_NOT_ALLOWED', `Scenario '${id}' is not allowed by profile '${profile.id}'`);
    }
  }
}
