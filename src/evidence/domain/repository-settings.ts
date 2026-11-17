/**
 * Repository settings the secure-by-design checks read.
 *
 * Each block is absent when the setting was not read: refused, not collected, or stored before the field
 * existed. Absent is not the same as weak, so the assessment never flags an absent block.
 *
 * `allowedActions` is GitHub's `allowed_actions` (`all`, `local_only` or `selected`), and it is absent when
 * Actions is disabled. `shaPinningRequired` is GitHub's `sha_pinning_required`: whether every Action a workflow
 * uses must be pinned to a full-length commit SHA. It is absent where GitHub did not send it. `creationPolicy` is GitHub's `issueCreationPolicy` (`ALL` or `COLLABORATORS_ONLY`).
 * Both are kept as strings so that a value GitHub adds later is stored rather than rejected.
 */
export interface RepositorySettings {
  actions?: { enabled: boolean; allowedActions?: string; shaPinningRequired?: boolean };
  issues?: { enabled: boolean; creationPolicy?: string };
}
