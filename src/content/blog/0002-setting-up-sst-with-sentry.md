---
title: "Setting up SST with Sentry"
description:
  "Setting up Sentry with SST, integrating with Lambda/Hono/tRPC/React, and automating sourcemap uploads"
pubDate: "2025-10-12"
---

## Introduction

Recently in my day job I had to migrate from self-hosted Sentry to Sentry.io.
Previously I was managing my Sentry keys and projects via Sentry Dashboard and
sourcemap upload was done by bespoke scripts so I felt it was an opportunity to
get this setup right. Since I was already using SST and remembered that SST
supports a lot of providers via pulumi I checked if it also supported Sentry.
Fortunately, it does! I started implementing and it took me about a day and a half,
but I'm happy with the results so I want to share what I learned.

In this blog post I'll show how I've setup Sentry with SST. This setup includes:

- Managing Sentry keys and projects via SST
- Integration of Sentry with Hono, tRPC, raw AWS Lambda and Static site built
  from Vite with React
- Upload of source maps to Sentry for all the above

BTW I also set up [example repo](https://github.com/klapacz/sst-sentry-example)
with working implementation of all of it.

### Prerequisites

- AWS Account
- Sentry Organization setup

## Core concepts

### Introduction to sentry provider

First, I added sentry [SST provider](https://sst.dev/docs/providers/) to my SST
app. You can view all available providers
[here](https://sst.dev/docs/all-providers#directory).

```sh
pnpm sst add @pulumiverse/sentry
```

This provider expects `SENTRY_AUTH_TOKEN` environment variable to be set, so I
added it to my `.env` file. You can get `SENTRY_AUTH_TOKEN` by creating new
personal token in Sentry Dashboard. I also added `SENTRY_ORG` and `SENTRY_TEAM`
variables.

```env title=".env"
SENTRY_AUTH_TOKEN=your-auth-token
SENTRY_ORG=your-org-slug
SENTRY_TEAM=your-team-slug
```

Now we can create projects like this.

```ts
const project = new sentry.SentryProject(`SentryProjectName`, {
  organization: process.env.SENTRY_ORG,
  teams: [process.env.SENTRY_TEAM],
  name: `${$app.stage}-sentry-project-name`,
});
```

And we can create keys like this:

```ts
const key = new sentry.SentryKey(`SentryKeyName`, {
  organization: project.organization,
  project: project.name,
});

key.dsnPublic; // This is public DSN for Sentry project that we later use to initialize Sentry SDK
```

## Lambda integration

Okay, we have created Sentry project and key. Let's now integrate it with
Lambda!

_This approach relies on Lambda Layers to work, so it won't work in
[live](https://sst.dev/docs/live/) mode. Please refer to the
[Reusable Helpers section](#reusable-helpers) to see how to programmatically
enable/disable Sentry setup in live/dev mode._

### Source map upload

Let's start with source map upload. It is needed because SST uploads minified
source code to AWS Lambda to minimize cold starts but when exception occurs I
want a full stack trace with actual code to know where exactly the error
originated from.

If you want to know more about cold starts in Lambda there is
[good video on this topic](https://www.youtube.com/watch?v=DZ18CRTgpg8) by Dax
from SST Team on youtube.

To upload source map I will use sentry-cli. I prefer to install it in project
instead of globally to avoid version conflicts and ensure consistency across
environments. For more info please refer to
[official sentry documentation](https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/)

```sh
pnpm add @sentry/cli
```

First I created a helper function that for given directory executes sentry cli
to inject Debug IDs and upload source maps.

```ts {28-29}
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCallback);

// ...

async function uploadSourcemaps({
  dir,
  SENTRY_PROJECT,
  SENTRY_ORG,
  SENTRY_AUTH_TOKEN,
}: {
  dir: string;
  SENTRY_PROJECT: string;
  SENTRY_ORG: string;
  SENTRY_AUTH_TOKEN: string;
}) {
  async function execSentry(cmd: string) {
    const { stdout } = await exec(cmd, {
      cwd: process.cwd(),
      env: { ...process.env, SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN },
    });

    console.log(stdout);
  }

  await execSentry(`pnpm sentry-cli sourcemaps inject ${dir}`);
  await execSentry(`pnpm sentry-cli sourcemaps upload ${dir}`);
}
```

To automate Lambda source map upload I used [postbuild
hook](https://sst.dev/docs/component/aws/function/#hook-postbuild). This hook
allows me to specify a callback that will be run after the Lambda function is
built. It takes directory with source code as argument.

I created a helper function that for given project generates a postbuild hook:

```ts
function createPostbuildHook({
  project,
  SENTRY_AUTH_TOKEN,
}: {
  project: sentry.SentryProject;
  SENTRY_AUTH_TOKEN: string;
}) {
  return async function postbuild(dir: string) {
    await new Promise<void>((resolve) => {
      $resolve([project.name, project.organization]).apply(
        ([SENTRY_PROJECT, SENTRY_ORG]) => {
          uploadSourcemaps({
            dir,
            SENTRY_PROJECT,
            SENTRY_ORG,
            SENTRY_AUTH_TOKEN,
          }).then(resolve);
        },
      );
    });
  };
}
```

Because we need project name resolved I used `new Promise` in conjunction with
[`$resolve`](https://sst.dev/docs/reference/global/#resolve) helper. I'm not
sure if this is the best way to handle this but it works. If you have a better
idea, please let me know in the comments below.

Now I can use new `createPostbuildHook` like this:

```ts {6}
const project = new sentry.SentryProject(/* ... */);

new sst.aws.Function("MyHono", {
  // ...
  hook: {
    postbuild: createPostbuildHook({ project, SENTRY_AUTH_TOKEN }),
  },
});
```

### Runtime configuration

I was basing on instructions for
[Lambda Layer Installation Method](https://docs.sentry.io/platforms/javascript/guides/aws-lambda/install/layer/).

Let's first install `@sentry/aws-serverless`.

```bash
pnpm add @sentry/aws-serverless
```

Sentry SDK should be initialized before the function starts. To do this in the
simplest way I created `mjs` file, so I don't have to build it. In this file I
initialize Sentry SDK and load it before the function code using
`--import <path_to_file>` node option.

This file is named `instrument.mjs` by convention and should look like this:

```ts title="packages/functions/src/instrument.mjs" {1,5}
import * as Sentry from "@sentry/aws-serverless";

Sentry.init({
  // eslint-disable-next-line no-undef
  dsn: process.env.SENTRY_DSN,
  // Adds request headers and IP for users, for more info visit:
  // https://docs.sentry.io/platforms/javascript/guides/aws-lambda/configuration/options/#sendDefaultPii
  sendDefaultPii: true,
  // Add Tracing by setting tracesSampleRate and adding integration
  // Set tracesSampleRate to 1.0 to capture 100% of transactions
  // We recommend adjusting this value in production
  // Learn more at
  // https://docs.sentry.io/platforms/javascript/configuration/options/#traces-sample-rate
  tracesSampleRate: 1.0,
});
```

As you can see I import `"@sentry/aws-serverless"` package. To include this
package in the Lambda I will use Lambda Layers. Let's define SST Function
Component:

```ts title="infra/api.ts"
const project = new sentry.SentryProject(/* ... */);
const key = new sentry.SentryKey(/* ... */);

export const myApi = new sst.aws.Function("MyApi", {
  handler: "packages/functions/src/api.handler",
  copyFiles: [
    { from: "packages/functions/src/instrument.mjs", to: "./instrument.mjs" }, // (1)
  ],
  layers: [
    "arn:aws:lambda:eu-central-1:943013980633:layer:SentryNodeServerlessSDKv10:25", // (2)
  ],
  nodejs: {
    esbuild: { external: ["@sentry/aws-serverless"] }, // (3)
  },
  environment: {
    SENTRY_DSN: key.dsnPublic, // (4)
    NODE_OPTIONS: "--import ./instrument.mjs ", // (5)
  },
  hook: {
    postbuild: createPostbuildHook({ project, SENTRY_AUTH_TOKEN }), // (6)
  },
});
```

I copied the `instrument.mjs` file into my function (1). I included the Layer
mentioned above (2). _Important:_ Layer ARNs are AWS region specific. Please
find proper ARN for your region in
[Sentry Docs](https://docs.sentry.io/platforms/javascript/guides/aws-lambda/install/layer/#1-add-the-sentry-lambda-layer).
Because I included `@sentry/aws-serverless` in Lambda Layer I could tell
esbuild to exclude it from function code bundle (3). I also provided
`SENTRY_DSN` environment variable used to initialize Sentry SDK (4) and told
node.js to load instrument.mjs before function code (5). At last I defined
postbuild hook with the helper mentioned above (6).

That's a lot to configure, and this would get very repetitive and hard to
maintain if we have a few Lambdas in our projects. That's why I extracted this
logic to a helper function. You can find it in
[Reusable Helpers section](#reusable-helpers).

Okay, to have all setup working last thing to do is to use `Sentry.wrapHandler`
like this.

```ts title="packages/functions/src/api.ts" {15}
import {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Handler,
} from "aws-lambda";
import * as Sentry from "@sentry/aws-serverless";

const handlerInner: Handler<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2
> = async (event) => {
  // ...
};

export const handler = Sentry.wrapHandler(handlerInner);
```

That's it for simple Lambda integration.

### Hono and tRPC Integration

If you use Hono framework the approach with `Sentry.wrapHandler` won't work
because Hono catches errors thrown in your code and just returns a 500 http
response. (I know because I spent an hour debugging why I didn't see any errors
in Sentry 😅)

Instead you should use `Sentry.captureException` in `Hono().onError` handler
like this.

```ts title="packages/functions/src/hono.ts" {9}
import * as Sentry from "@sentry/aws-serverless";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";

const app = new Hono().onError((error, c) => {
  if (error instanceof HTTPException) {
    return error.getResponse(); // HTTPException are expected errors
  }
  Sentry.captureException(error); // Send unexpected errors to sentry
  return c.json({ error: "Internal server error" }, 500);
});

export const handler = handle(app);
```

For tRPC you can use `Sentry.trpcMiddleware` like this.

```ts title="packages/functions/src/trpc.ts" {7-9}
import * as Sentry from "@sentry/aws-serverless";
import { initTRPC } from "@trpc/server";

// ...

export const publicProcedure = t.procedure.use(
  Sentry.trpcMiddleware({
    attachRpcInput: true,
  }),
);
```

The nice thing is that it will automatically capture input sent to your
procedures.

## Reusable helpers

To make working with Sentry infrastructure more straightforward I've created a
few helper functions.

First one is `createFunctionArgs`. It creates an SST Function Component
arguments. It's based on what we've done in [Lambda Integration
section](#lambda-integration).

```ts
export function createFunctionArgs({
  SENTRY_AUTH_TOKEN,
  project,
  key,
  pathToInstrumentation,
}: {
  SENTRY_AUTH_TOKEN: string;
  project: sentry.SentryProject;
  key: sentry.SentryKey;
  pathToInstrumentation: string;
}) {
  if ($dev) return undefined; // Layers do not work in live/dev mode

  const instrumentationInLambda = "./instrument.mjs";
  const postbuild = createPostbuildHook({ project, SENTRY_AUTH_TOKEN });

  const functionArgs = {
    copyFiles: [{ from: pathToInstrumentation, to: instrumentationInLambda }],
    hook: { postbuild },
    layers: [SENTRY_LAMBDA_LAYER],
    nodejs: {
      // External because it's added by the Sentry Layer
      esbuild: { external: ["@sentry/aws-serverless"] },
    },
    environment: {
      SENTRY_DSN: key.dsnPublic,
      NODE_OPTIONS: `--import ${instrumentationInLambda}`,
    },
  } satisfies Partial<sst.aws.FunctionArgs>;

  return functionArgs;
}
```

This simplifies Function Component definition to this:

```ts title="infra/api.ts"
const project = new sentry.SentryProject(/* ... */);
const key = new sentry.SentryKey(/* ... */);

const sentryArgs = createFunctionArgs({
  SENTRY_AUTH_TOKEN,
  project,
  key,
  pathToInstrumentation: "packages/functions/src/instrument.mjs",
});

export const myApi = new sst.aws.Function("MyApi", {
  ...sentryArgs,
  handler: "packages/functions/src/api.handler",
});
```

I don't use Sentry in development, so I set up another helper to execute
code only if environment variables required for Sentry to work are present:

```ts
export function onSentryEnabled<T, U = undefined>({
  onEnabled,
  onDisabled,
}: {
  onEnabled: OnSentryEnabledCallback<T>;
  onDisabled?: () => U;
}): T | U | undefined {
  const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_TEAM } = process.env;
  if (!SENTRY_AUTH_TOKEN || !SENTRY_ORG || !SENTRY_TEAM) return onDisabled?.();
  return onEnabled({ SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_TEAM });
}
```

And another function that uses `onEnabled` to create project and key resources.

```ts
export function setupSentryResources<T, U = undefined>({
  name,
  opts,
  onEnabled,
  onDisabled,
}: {
  name: string;
  opts: SetupSentryResourcesOpts;
  onEnabled: SetupSentryResourcesCallback<T>;
  onDisabled?: () => U;
}): T | U | undefined {
  return onSentryEnabled({
    onEnabled: (args) => {
      // Create project
      const project = new sentry.SentryProject(`SentryProject${name}`, {
        ...opts,
        organization: args.SENTRY_ORG,
        teams: [args.SENTRY_TEAM],
        name: `${$app.stage}-${name.toLowerCase()}`,
      });

      // Create key
      const key = new sentry.SentryKey(`SentryKey${name}`, {
        organization: project.organization,
        project: project.name,
      });

      return onEnabled({ ...args, project, key });
    },
    onDisabled,
  });
}
```

With this helper Function Component definition looks like this:

```ts title="infra/api.ts"
const sentryArgs = setupSentryResources({
  name: "MyApi",
  opts: { platform: "node-awslambda" },
  onEnabled: ({ key, project, SENTRY_AUTH_TOKEN }) => {
    return createFunctionArgs({
      SENTRY_AUTH_TOKEN,
      project,
      key,
      pathToInstrumentation: "packages/functions/src/instrument.mjs",
    });
  },
});

export const myApi = new sst.aws.Function("MyApi", {
  ...sentryArgs,
  handler: "packages/functions/src/api.handler",
});
```

## Frontend Integration

In case of vite setup instead of using sentry cli I use vite plugin.

Let's first install the vite plugin and Sentry SDK for react.

```bash
pnpm add -D @sentry/vite-plugin
pnpm add @sentry/react
```

And define StaticSite SST Component.

```ts title="infra/web.ts"
import { myApi } from "./api";
import { myHono } from "./hono";

const sentryEnv = setupSentryResources({
  name: "Webapp",
  opts: { platform: "javascript-react" },
  onEnabled: ({ SENTRY_AUTH_TOKEN, project, key }) => ({
    SENTRY_AUTH_TOKEN, // (1)
    SENTRY_ORG: project.organization, // (1)
    SENTRY_PROJECT: project.name, // (1)
    VITE_SENTRY_DSN: key.dsnPublic, // (2)
  }),
  onDisabled: () => ({
    // (3)
    SENTRY_AUTH_TOKEN: "",
    SENTRY_ORG: "",
    SENTRY_PROJECT: "",
    VITE_SENTRY_DSN: "",
  }),
});

export const myWeb = new sst.aws.StaticSite("MyWeb", {
  // ...
  environment: {
    // ...
    ...sentryEnv, // (4)
  },
});
```

I provide environment variables required for Sentry vite plugin to work (1) and
also the `VITE_SENTRY_DSN` variable, which is available to the client so I can
initialize Sentry in application code. I also provide fallback values (3)
because SST generates an `sst-env.d.ts` file with `ImportMetaEnv` declarations
based on the provided `environment` argument and I rather don't want this file
to change all the time. The last thing is to inject those env variables into my
StaticStie (4).

Now I create `instrument.ts` file.

```ts title="packages/web/src/instrument.ts"
import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  // Adds request headers and IP for users, for more info visit:
  // https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/#sendDefaultPii
  sendDefaultPii: true,
  integrations: [],
});
```

And import it in my app entrypoint as first import.

```ts title="packages/web/src/main.tsx" {1}
import "./instrument";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
```

Okay, to complete frontend setup I set up vite plugin like this. Remember to
enable `build.sourcemap` option otherwise there will be no source maps to
upload.

```ts title="packages/web/vite.config.ts" {6,9-13}
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    react(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
});
```

## Gotchas

- Sometimes you have to wait a few minutes before exception will be visible in
  Sentry Dashboard
- I found out that `sentry.SentryProject` component creates Sentry project with
  sanitized name (for example by replacing multiple dashes with a single dash),
  but returns unsanitized name. This creates a mismatch where the returned name
  doesn't match the actual project created in Sentry. That's why I created a
  `sanitizeSentryProjectArgs` function. It's available in the
  [repo](https://github.com/klapacz/sst-sentry-example).

## Conclusion

Setting up Sentry with SST is not the easiest thing to do but after carefully
reading the docs and some artisaning it works well. I hope this article will
help you to set it up.

By the way, it's my first time writing long-form content (previous blog post was
mostly generated by AI 🫣) so please tell me what you think.

If you have any suggestions or feedback you can write a comment below or open
pull request [here](https://github.com/klapacz/homepage).

Of course [example repo](https://github.com/klapacz/sst-sentry-example) with
working setup with all mentioned things is available.

Thanks for reading and happy coding!
