import {
  GitManager,
  RepoData,
  ContributorData,
  IssueData,
  PullRequestData,
  GitManagerConfig,
  ContributionData,
  UserData,
  UserPullRequestData,
} from './types';
import {
  restEndpointMethods,
  RestEndpointMethodTypes,
} from '@octokit/plugin-rest-endpoint-methods';
import { project, projectClaim } from '@workspace/db/schema';
import { getCached, createCacheKey } from '../utils/cache';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { Octokit } from '@octokit/core';
import { type Context } from './utils';
const MyOctokit = Octokit.plugin(restEndpointMethods);

export class GithubManager implements GitManager {
  private octokit: InstanceType<typeof MyOctokit>;

  constructor(config: GitManagerConfig) {
    this.octokit = new MyOctokit({ auth: config.token });
  }

  private parseRepoIdentifier(identifier: string): { owner: string; repo: string } {
    const [owner, repo] = identifier.split('/');
    if (!owner || !repo) {
      throw new Error('Invalid repository format. Use: username/repository');
    }
    return { owner, repo };
  }

  async getCurrentUser(): Promise<{
    id: string;
    username: string;
  }> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return {
      id: data.id.toString(),
      username: data.login,
    };
  }

  async getRepo(identifier: string): Promise<RepoData> {
    const { owner, repo } = this.parseRepoIdentifier(identifier);

    return getCached(
      createCacheKey('github', 'repo', identifier),
      async () => {
        const { data } = await this.octokit.rest.repos.get({ owner, repo });

        return {
          ...data,
          id: data.id,
          name: data.name,
          description: data.description ?? undefined,
          url: data.html_url,
          isPrivate: data.private,
        };
      },
      { ttl: 5 * 60 },
    );
  }

  async getRepoPermissions(
    identifier: string,
  ): Promise<
    RestEndpointMethodTypes['repos']['getCollaboratorPermissionLevel']['response']['data']
  > {
    const { owner, repo } = this.parseRepoIdentifier(identifier);
    const currentUser = await this.getCurrentUser();
    const { data } = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: currentUser.username,
    });
    return data;
  }

  async getContributors(identifier: string): Promise<ContributorData[]> {
    const { owner, repo } = this.parseRepoIdentifier(identifier);

    return getCached(
      createCacheKey('github', 'contributors', identifier),
      async () => {
        const allContributors: any[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
          const { data } = await this.octokit.rest.repos.listContributors({
            owner,
            repo,
            per_page: 100,
            page,
          });

          allContributors.push(...data);

          hasMore = data.length === 100;
          page++;

          if (page > 50) break;
        }

        return allContributors.map((c) => ({
          ...c,
          id: c.id!,
          username: c.login!,
          avatarUrl: c.avatar_url,
        }));
      },
      { ttl: 60 * 60 },
    );
  }

  async getIssues(identifier: string): Promise<IssueData[]> {
    const { owner, repo } = this.parseRepoIdentifier(identifier);

    return getCached(
      createCacheKey('github', 'issues', identifier),
      async () => {
        const { data } = await this.octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: 'all',
          per_page: 100,
        });
        return data.map((i) => ({
          ...i,
          id: i.id,
          title: i.title,
          state: i.state,
          url: i.html_url,
        }));
      },
      { ttl: 10 * 60 },
    );
  }

  async getPullRequests(identifier: string): Promise<PullRequestData[]> {
    const { owner, repo } = this.parseRepoIdentifier(identifier);

    return getCached(
      createCacheKey('github', 'pulls', identifier),
      async () => {
        const { data } = await this.octokit.rest.pulls.list({
          owner,
          repo,
          state: 'all',
          per_page: 100,
        });
        return data.map((p) => ({
          ...p,
          id: p.id,
          title: p.title,
          state: p.state,
          url: p.html_url,
        }));
      },
      { ttl: 10 * 60 },
    );
  }

  async getRepoData(identifier: string) {
    const [repoData, contributors, issues, pullRequests] = await Promise.all([
      this.getRepo(identifier),
      this.getContributors(identifier),
      this.getIssues(identifier),
      this.getPullRequests(identifier),
    ]);

    return {
      repo: repoData,
      contributors,
      issues,
      pullRequests,
    };
  }

  async verifyOwnership(
    identifier: string,
    ctx: Context,
    projectId: string,
  ): Promise<{
    success: boolean;
    project: typeof project.$inferSelect;
    ownershipType: string;
    verifiedAs: string;
  }> {
    const { owner, repo } = this.parseRepoIdentifier(identifier);

    const currentUser = await this.getCurrentUser();

    const repoData = await this.getRepo(identifier);

    let isOwner = false;
    let ownershipType = '';

    if (repoData.owner.login === currentUser.username) {
      isOwner = true;
      ownershipType = 'repository owner';
    } else if (repoData.owner.type === 'Organization') {
      console.log(
        `Checking org ownership for ${currentUser.username} in org ${repoData.owner.login}`,
      );

      try {
        const { data: repoPermissions } =
          await this.octokit.rest.repos.getCollaboratorPermissionLevel({
            owner,
            repo,
            username: currentUser.username,
          });

        console.log(
          `User ${currentUser.username} has ${repoPermissions.permission} permission on the repository`,
        );

        if (repoPermissions.permission === 'admin') {
          try {
            const { data: membership } = await this.octokit.rest.orgs.getMembershipForUser({
              org: repoData.owner.login,
              username: currentUser.username,
            });

            console.log(
              `User ${currentUser.username} has role '${membership.role}' in org with state '${membership.state}'`,
            );

            if (membership.role === 'admin' && membership.state === 'active') {
              isOwner = true;
              ownershipType = 'organization owner';
            }
          } catch (orgError) {
            console.log('Error checking org membership:', orgError);
            isOwner = true;
            ownershipType = 'repository admin';
          }
        }
      } catch (error) {
        console.log(
          'User does not have collaborator access to the repository:',
          error instanceof Error ? error.message : String(error),
        );

        try {
          const { data: membership } = await this.octokit.rest.orgs.getMembershipForUser({
            org: repoData.owner.login,
            username: currentUser.username,
          });

          if (membership.role === 'admin' && membership.state === 'active') {
            isOwner = true;
            ownershipType = 'organization owner';
          }
        } catch (orgError) {
          console.log('User is not a member of the organization');
        }
      }
    }

    if (!isOwner) {
      console.log(`Claim denied for user ${currentUser.username} on repo ${owner}/${repo}`);
      await ctx.db.insert(projectClaim).values({
        projectId,
        userId: ctx.session!.userId,
        success: false,
        verificationMethod: 'github_api',
        verificationDetails: {
          verifiedAs: currentUser.username,
          repoOwner: repoData.owner.login,
          repoOwnerType: repoData.owner.type,
          reason: 'insufficient_permissions',
        },
        errorReason: `User ${currentUser.username} does not have required permissions. Repository owner: ${repoData.owner.login}`,
      });

      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You don't have the required permissions to claim this project. You must be either the repository owner or an organization owner. Current user: ${currentUser.username}, Repository owner: ${repoData.owner.login}`,
      });
    }

    console.log(`Claim approved: ${currentUser.username} is ${ownershipType} for ${owner}/${repo}`);

    const updatedProject = await ctx.db
      .update(project)
      .set({
        ownerId: ctx.session?.userId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(project.id, projectId), isNull(project.ownerId)))
      .returning();

    if (!updatedProject[0]) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Project has already been claimed by another user',
      });
    }
    await ctx.db.insert(projectClaim).values({
      projectId,
      userId: ctx.session!.userId,
      success: true,
      verificationMethod: ownershipType,
      verificationDetails: {
        verifiedAs: currentUser.username,
        repoOwner: repoData.owner.login,
        repoOwnerType: repoData.owner.type,
        ownershipType,
        repositoryUrl: `https://github.com/${owner}/${repo}`,
      },
    });

    // Create a notification or send an email to inform about the claim
    // This would require implementing a notification system
    // Example: await createNotification({
    //   type: 'project_claimed',
    //   projectId: input.projectId,
    //   newOwnerId: ctx.session.userId,
    // });

    return {
      success: true,
      project: updatedProject[0],
      ownershipType,
      verifiedAs: currentUser.username,
    };
  }

  async getOrgMembership(
    org: string,
    username: string,
  ): Promise<RestEndpointMethodTypes['orgs']['getMembershipForUser']['response']['data']> {
    const { data } = await this.octokit.rest.orgs.getMembershipForUser({ org, username });
    return data;
  }

  async getUserDetails(username: string): Promise<UserData> {
    return getCached(
      createCacheKey('github', 'user', username),
      async () => {
        try {
          const { data } = await this.octokit.rest.users.getByUsername({ username });

          return {
            provider: 'github',
            login: data.login,
            id: data.id,
            avatarUrl: data.avatar_url,
            name: data.name ?? undefined,
            company: data.company ?? undefined,
            blog: data.blog ?? undefined,
            location: data.location ?? undefined,
            email: data.email ?? undefined,
            bio: data.bio ?? undefined,
            publicRepos: data.public_repos,
            publicGists: data.public_gists,
            followers: data.followers,
            following: data.following,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
            htmlUrl: data.html_url,
          };
        } catch (error) {
          if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `GitHub user '${username}' not found`,
            });
          }
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed to fetch GitHub user details: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
      { ttl: 30 * 60 },
    );
  }

  getContributions(username: string): Promise<ContributionData[]> {
    throw new Error('Method not implemented.');
  }

  async getUserPullRequests(
    username: string,
    options?: {
      state?: 'open' | 'closed' | 'merged' | 'all';
      limit?: number;
    },
  ): Promise<UserPullRequestData[]> {
    const limit = options?.limit || 100;
    const stateFilter = options?.state || 'all';

    // Start with a simpler query and add fields progressively
    const query = `
      query GetUserPullRequests($username: String!, $first: Int!, $after: String) {
        user(login: $username) {
          pullRequests(first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              number
              title
              state
              isDraft
              createdAt
              updatedAt
              closedAt
              mergedAt
              url
              headRefName
              baseRefName
              repository {
                nameWithOwner
                url
                isPrivate
                owner {
                  login
                }
              }
            }
          }
        }
      }
    `;

    const allPRs: UserPullRequestData[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    try {
      while (hasNextPage && allPRs.length < limit) {
        const response: any = await this.octokit.graphql<{
          user: {
            pullRequests: {
              totalCount: number;
              pageInfo: {
                hasNextPage: boolean;
                endCursor: string | null;
              };
              nodes: Array<{
                id: string;
                number: number;
                title: string;
                state: 'OPEN' | 'CLOSED' | 'MERGED';
                isDraft: boolean;
                createdAt: string;
                updatedAt: string;
                closedAt: string | null;
                mergedAt: string | null;
                url: string;
                headRefName: string;
                baseRefName: string;
                repository: {
                  nameWithOwner: string;
                  url: string;
                  isPrivate: boolean;
                  owner: {
                    login: string;
                  };
                };
              }>;
            };
          };
        }>(query, {
          username,
          first: Math.min(100, limit - allPRs.length),
          after: cursor,
        });

        if (!response.user) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `GitHub user '${username}' not found`,
          });
        }

        const prs = response.user.pullRequests.nodes;

        const formattedPRs: UserPullRequestData[] = prs.map((pr: any) => ({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          state: pr.state.toLowerCase(),
          url: pr.url,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          closedAt: pr.closedAt || undefined,
          mergedAt: pr.mergedAt || undefined,
          isDraft: pr.isDraft,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          repository: {
            nameWithOwner: pr.repository.nameWithOwner,
            url: pr.repository.url,
            isPrivate: pr.repository.isPrivate,
            owner: {
              login: pr.repository.owner.login,
            },
          },
        }));

        const filteredPRs = formattedPRs.filter((pr) => {
          if (stateFilter === 'all') return true;
          if (stateFilter === 'open') return pr.state === 'open';
          if (stateFilter === 'closed') return pr.state === 'closed' && !pr.mergedAt;
          if (stateFilter === 'merged') return pr.state === 'merged' || !!pr.mergedAt;
          return true;
        });

        allPRs.push(...filteredPRs);

        hasNextPage = response.user.pullRequests.pageInfo.hasNextPage;
        cursor = response.user.pullRequests.pageInfo.endCursor;

        if (!hasNextPage || allPRs.length >= limit) {
          break;
        }
      }

      return allPRs.slice(0, limit);
    } catch (error) {
      console.error('Error fetching GitHub PRs:', error);
      if (error instanceof TRPCError) {
        throw error;
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to fetch pull requests: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
