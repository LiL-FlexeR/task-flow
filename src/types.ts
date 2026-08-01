export interface ClickUpConfig {
  apiBaseUrl: string;
  branchFieldId?: string;
  pullRequestFieldId?: string;
  deployFlowFieldId?: string;
  deployFlowFieldName: string;
  teamId?: string;
}

export interface PullRequestBranches {
  master: string;
  staging?: string;
}

export interface WorkflowConfig {
  branch: string;
  pullRequestBranches: PullRequestBranches;
  branchPrefix: string;
  remote: string;
  pull: boolean;
  draft: boolean;
  featureBranch?: string;
  clickup: ClickUpConfig;
}

export interface ConfigLayer {
  branch?: string;
  pullRequestBranches?: Partial<PullRequestBranches>;
  branchPrefix?: string;
  remote?: string;
  pull?: boolean;
  draft?: boolean;
  featureBranch?: string;
  clickup?: Partial<ClickUpConfig>;
}

export interface ConfigFile {
  defaults?: ConfigLayer;
  repositories?: Record<string, ConfigLayer>;
}

export interface RepositoryContext {
  root: string;
  nameWithOwner: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
