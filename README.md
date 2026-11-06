# Vehicle Manager

A local Windows workspace for vehicle engineering data, components, DOVE reports, attachments, change history and team collaboration through an existing SMB shared folder. The interface supports English and Chinese.

## Download and run

Download the application ZIP from the [latest official release](https://github.com/yongkang2/vehicle-manager/releases/latest), extract the entire archive to a writable local folder, and run **Start.cmd**. Use **Stop.cmd** for a safe shutdown. The portable package includes Node.js; no separate installation is required.

Before upgrading, save your work, stop the old service and independently back up local data and the team share. Keep your own data directory and upgrade collaborating clients together.

## Documentation

- [English user guide](docs/portable-guide.en.md)
- [Chinese user guide](docs/user-guide.zh-CN.md)
- [Development and implementation notes](docs/developer-guide.md)
- [Product, design and interaction conventions](docs/design.md)
- [Release history and publishing rules](docs/releases.md)
- [All documentation](docs/README.md)

Configuration revisions and administrator-managed component review policies are described in the user and development guides. Existing component records remain editable when their type is excluded from configuration review.

## Development

Node.js 24 or newer is required. Install dependencies with `npm ci`, then run `npm run build`.

- `npm run dev:server` and `npm run dev`: start the backend and frontend development servers in separate terminals.
- `npm test`: run the regression suite after building.
- `npm run lint`: run code checks.
- `npm run package:portable`: build, validate and package an official Windows x64 release.

The application version is defined in `package.json`. Commit messages, PRs, release notes and packaged instructions use English. See [AGENTS.md](AGENTS.md) for maintained repository rules.

Real multi-computer SMB behavior and company endpoint policies require validation on the destination computers. STELLANTIS trademark rights remain with their owner; this project does not imply official authorization.
