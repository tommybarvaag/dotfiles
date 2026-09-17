---
name: write-effect-function
description: Choosing Effect.gen/yield* vs .pipe when writing Effect-TS code. Use when writing or reviewing an Effect, deciding whether logic belongs in a generator body or a pipe, composing Layers, wiring tracing/retry/error handling, or when an effect reads as a wall of .andThen/.flatMap/.map chains.
---

# Writing an Effect function

Core rule: **`Effect.gen` + `yield*` for business logic (sequential and conditional). `.pipe` for composition, simple transforms, and cross-cutting concerns.** Use both together — business logic inside the generator, composition outside.

```ts
Effect.gen(function* () {
  // business logic lives here
}).pipe(
  // composition happens here
)
```

## Decision matrix

| You are doing | Use |
| --- | --- |
| Injecting / retrieving dependencies | `Effect.gen` |
| Conditional logic | `Effect.gen` |
| Sequential operations | `Effect.gen` |
| Error handling | `.pipe` |
| Adding tracing | `.pipe` |
| Layer building | `.pipe` |
| Simple transforms | `.pipe` |

## `Effect.gen` — sequential & conditional logic

Multi-step operations read top-to-bottom, like `async`/`await`:

```ts
const createUser = (userData) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const validated = yield* validateUserData(userData);
    const hashed = yield* hashPassword(validated.password);
    const user = yield* db.users.create({ ...validated, password: hashed });
    return yield* enrichUserData(user);
  });
```

Conditionals stay native — no `.map`/`.andThen`/`.flatMap` walls:

```ts
const processPayment = (payment) =>
  Effect.gen(function* () {
    const config = yield* Config;

    if (payment.amount > config.largePaymentThreshold) {
      return yield* processLargePayment(payment);
    }
    return yield* processStandardPayment(payment);
  });
```

Don't express sequential logic as a `.pipe` chain:

```ts
// don't do it, even if it is fun
Effect.succeed(order).pipe(
  Effect.andThen(validateOrder),
  Effect.andThen(calculateTotals),
  Effect.andThen(applyDiscounts),
  Effect.andThen(processPayment),
  Effect.andThen(sendConfirmation),
);

// much better
Effect.gen(function* () {
  const validated = yield* validateOrder(order);
  const withTotals = yield* calculateTotals(validated);
  const discounted = yield* applyDiscounts(withTotals);
  const payment = yield* processPayment(discounted);
  return yield* sendConfirmation(payment);
});
```

## `.pipe` — composition & transforms

Building dependency layers — clean, composable:

```ts
const appLayer = Layer.empty.pipe(
  Layer.provide(Database.layer),
  Layer.provide(Logger.layer),
  Layer.provideMerge(Metrics.layer),
  Layer.provideMerge(Cache.layer),
);
```

`Layer.provide` feeds a dependency and hides it; `Layer.provideMerge` feeds it and keeps it in the output.

Inside a gen, a one-step transform of a result doesn't need its own generator:

```ts
// this is fine
const usernames = yield* getActiveUsers().pipe(
  Effect.map(users => users.map(u => u.username))
);
```

## Combine: business logic inside, cross-cutting outside

The generator owns the business logic; the `.pipe` tail adds cross-cutting concerns (tracing, retry, error recovery):

```ts
const fetchUserPosts = (userId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const cache = yield* Cache;

    const cached = yield* cache.get(`posts:${userId}`);
    if (cached) return cached;

    const posts = yield* db.posts.findByUser(userId);
    yield* cache.set(`posts:${userId}`, posts);

    return posts;
  }).pipe(
    Effect.withSpan("fetch_user_posts"),
    Effect.retry(retryPolicy),
    Effect.catchTag("DatabaseError", () => Effect.succeed([])),
  );
```

Tail order matters: `Effect.retry` is exhausted first, then `Effect.catchTag` supplies the fallback.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| `.pipe(Effect.andThen(…), Effect.andThen(…))` for sequential logic | rewrite as a gen body with `yield*` per step |
| Nested `Effect.flatMap` to express an `if` | use a native `if` / ternary inside `Effect.gen` |
| A generator for a one-step transform | `.pipe(Effect.map(…))` |
| Business logic in the `.pipe` tail | keep it in the gen body; the tail is cross-cutting only |

---

Adapted from Dillon Mulroy's thread on writing Effect: <https://x.com/dillon_mulroy/status/1936530534936486009>
