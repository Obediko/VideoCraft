# Vertical slice 01: project and proposal foundation

This slice adds the first executable application boundary:

- create a project with validated ownership and name;
- register an asset only for an existing project;
- validate SHA-256 asset checksums;
- save immutable timeline revisions;
- advance the project revision atomically at the application boundary;
- expose a versioned strategy registry;
- generate an explainable short-form proposal without mutating the project.

The repositories are in-memory for this slice. They are deliberately replaceable by a database adapter in the next slice. Provider calls, authentication, API transport, and media processing are not faked here; their ports remain explicit so they cannot leak into domain logic.
