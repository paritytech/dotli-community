# A fallback for a browser of the floor's era

A developer runs a simplification pass or a review over code that already works. They find a fallback, such as a
default value in a CSS `var()` or a guard around an API. The fallback covers a feature that Safari 17.4 has but that
another browser of the same era lacked, such as a Firefox release from around then. The floor in `AGENTS.md` names only
ES2022 and Safari 17.4, and other code may rely on the same feature with no fallback. The question is whether the floor
binds only Safari, so that the fallback can go.

## How to resolve

1. Ask which browsers the fallback serves. When one is a release of the floor's era that lacks the feature, the
   fallback still does work.
2. Weigh what it costs to keep, such as a few tokens and a comment.
3. Keep a cheap fallback that lets such a browser show the design as intended. Do not delete it on the ground that the
   floor names Safari alone.
4. Leave other code that relies on the feature without a fallback as it is. This rule keeps a fallback that exists. It
   does not ask a cleanup to add one elsewhere.

The owner chose to keep the fallback, by picking the offered option whose reason was that it is cheap and a Firefox of
the floor's era still shows the design.

## Example

A dot placed on a ring by an animated, registered angle:

```css
/* Kept: a browser with CSS trig but no @property reads 0deg and shows the dot at rest */
.marker {
  translate:
    calc(cos(var(--spin-turn, 0deg)) * 40px)
    calc(sin(var(--spin-turn, 0deg)) * 40px);
}

/* Not this: without the default, that browser finds the var invalid and the dot collapses to the centre */
.marker {
  translate:
    calc(cos(var(--spin-turn)) * 40px)
    calc(sin(var(--spin-turn)) * 40px);
}
```

## Cases

- A landing page's orbit animates registered `@property` angles and reads them with a `0deg` default, added by a review
  fix so a browser with CSS trig but no `@property` shows the dots at rest. Firefox gained `@property` four months after
  Safari 17.4, so its releases in between have trig without it. Other host CSS modules rely on `@property` with no
  fallback. A simplification round asked whether to drop the defaults, and the owner kept them.
  (simplify/landing-horizon, reduce-complexity run on feat/landing-horizon)

Status: active
