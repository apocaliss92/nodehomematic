/**
 * Program (rule/automation) domain record as exposed by the hub layer.
 */

/** A CCU program as returned by `Program.getAll`, normalised. */
export interface HmProgramRecord {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly isInternal: boolean;
  readonly lastExecuteTime?: string;
}
