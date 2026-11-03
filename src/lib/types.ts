// Jira 6.0 REST v2 返回结构中本项目用到的部分
export interface NamedRef {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface JiraUser {
  name: string;
  displayName: string;
  emailAddress?: string;
}

export interface LinkedIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: NamedRef;
    priority?: NamedRef;
    issuetype: NamedRef;
  };
}

export interface IssueLink {
  id: string;
  type: { name: string; inward: string; outward: string };
  inwardIssue?: LinkedIssue;
  outwardIssue?: LinkedIssue;
}

export interface IssueFields {
  summary: string;
  status: NamedRef;
  issuetype: NamedRef;
  priority?: NamedRef | null;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  components?: NamedRef[];
  created?: string;
  updated?: string;
  issuelinks?: IssueLink[];
  [field: string]: unknown;
}

export interface Issue {
  id: string;
  key: string;
  fields: IssueFields;
}

export interface SearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: Issue[];
}

export interface Project {
  id: string;
  key: string;
  name: string;
}

export interface ProjectDetail extends Project {
  lead?: JiraUser;
  components: NamedRef[];
  issueTypes: NamedRef[];
  versions?: Version[];
}

export interface Version {
  id: string;
  name: string;
  description?: string;
  released?: boolean;
  archived?: boolean;
  releaseDate?: string;
}

export interface Comment {
  id: string;
  author?: JiraUser;
  updateAuthor?: JiraUser;
  body: string;
  created: string;
  updated?: string;
}

export interface ChangelogHistory {
  id: string;
  author?: JiraUser;
  created: string;
  items: { field: string; fromString: string | null; toString: string | null }[];
}

export interface IssueDetail extends Issue {
  names?: Record<string, string>;
  renderedFields?: { description?: string | null; comment?: { comments: Comment[] } };
  changelog?: { histories: ChangelogHistory[] };
}

export interface Attachment {
  id: string;
  filename: string;
  author?: JiraUser;
  created: string;
  size: number;
  mimeType: string;
  content: string;
  thumbnail?: string;
}

export interface FieldDef {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string };
}
