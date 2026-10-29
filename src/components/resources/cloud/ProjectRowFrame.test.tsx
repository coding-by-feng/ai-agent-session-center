// Security review, Oct 29 2026: a saved project's `url` comes from AASC Cloud and is not checked to
// be GitHub's, so a row links to the GitHub page its owner and name name.
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import ProjectRowFrame from './ProjectRowFrame';
import { folderStatus } from './projectState';

it('links the repository to its GitHub page, whatever url the record carries', () => {
  render(
    <ul>
      <ProjectRowFrame
        name="app"
        favColumn={false}
        path={null}
        home={null}
        lastActivityAt={null}
        repository={{
          provider: 'github',
          owner: 'a b',
          name: 'c?d',
          url: 'https://evil.example/login',
          branch: 'main',
        }}
        status={folderStatus('unsaved')}
        button={null}
      />
    </ul>,
  );
  expect(screen.getByRole('link', { name: 'a b/c?d' })).toHaveAttribute(
    'href',
    'https://github.com/a%20b/c%3Fd',
  );
});

// Card view, Oct 29 2026: the same parts as a row, stacked. The ♥ and ⋯ sit at the head; the
// state and the button at the foot, under whatever the row adds (a hint, a panel, a job).
it('stacks a card: name and tools, then folder, time and repository, then its foot', () => {
  render(
    <ul>
      <ProjectRowFrame
        layout="card"
        name="app"
        favColumn
        fav={<button type="button">Favourite app</button>}
        branch="main"
        tags={['web']}
        path="/Users/me/code/app"
        home="/Users/me"
        lastActivityAt={Date.now()}
        repository={{
          provider: 'github',
          owner: 'me',
          name: 'app',
          url: 'https://github.com/me/app',
          branch: 'main',
        }}
        status={folderStatus('unsaved')}
        button={<button type="button">Save</button>}
        menu={<button type="button">More actions for app</button>}
      >
        <p>A hint from the row</p>
      </ProjectRowFrame>
    </ul>,
  );
  const follows = (a: Element, b: Element) =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const name = screen.getByText('app'),
    fav = screen.getByRole('button', { name: 'Favourite app' }),
    more = screen.getByRole('button', { name: 'More actions for app' }),
    // The folder has a line of its own, not "folder · time · repository".
    folder = screen.getByText('~/code/app'),
    repo = screen.getByRole('link', { name: 'me/app' }),
    tags = screen.getByText('#web'),
    hint = screen.getByText('A hint from the row'),
    state = screen.getByText('Not saved'),
    save = screen.getByRole('button', { name: 'Save' });
  for (const [a, b] of [
    [name, fav],
    [fav, more],
    [more, folder],
    [folder, repo],
    [repo, tags],
    [tags, hint],
    [hint, state],
    [state, save],
  ] as const)
    expect(follows(a, b)).toBe(true);
});

it('leaves the ♥ off a card while AASC Cloud keeps no project ♥', () => {
  render(
    <ul>
      <ProjectRowFrame
        layout="card"
        name="app"
        favColumn={false}
        fav={<button type="button">Favourite app</button>}
        path={null}
        home={null}
        lastActivityAt={null}
        repository={null}
        status={folderStatus('plain')}
        button={null}
      />
    </ul>,
  );
  expect(screen.queryByRole('button', { name: 'Favourite app' })).toBeNull();
  expect(screen.getByText('No GitHub remote')).toBeInTheDocument();
});
