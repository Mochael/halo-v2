import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "finds current file buffers and visible conversation text",
  async ({ app, llm }) => {
    await app.server.rpc.workspace.writeFile({
      path: "plain.txt",
      content: "Silver marmot and silver marmot",
    });
    await app.server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "# Silver marmot\n\nBefore  \nAnother silver marmot",
    });
    await app.server.rpc.workspace.writeFile({
      path: "source.ts",
      content: "const marmot = 'silver marmot';",
    });

    await app.page.getByRole("link", { name: "plain.txt" }).click();
    await app.page.keyboard.press("ControlOrMeta+f");
    const find = app.page.getByRole("search", { name: "Find in tab" });
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("SILVER MARMOT");
    await expect(find).toContainText("1 of 2");
    const plainHighlight = app.page
      .getByRole("main", { name: "plain.txt" })
      .locator("mark");
    await expect(plainHighlight).toHaveText("Silver marmot");
    await expect(plainHighlight).toBeVisible();
    await find.getByRole("button", { name: "Next match" }).click();
    await expect(find).toContainText("2 of 2");
    await app.page.keyboard.press("Escape");
    await expect(find).toBeHidden();
    await expect(plainHighlight).toHaveCount(0);

    await app.page.getByRole("link", { name: "notes.md" }).click();
    await app.page.keyboard.press("ControlOrMeta+f");
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("silver marmot");
    await expect(find).toContainText("1 of 2");
    await find.getByRole("button", { name: "Next match" }).click();
    await expect(find).toContainText("2 of 2");
    const markdownHighlight = app.page
      .getByRole("main", { name: "notes.md" })
      .locator(".halo-find-active-match");
    await expect(markdownHighlight).toHaveText("silver marmot");
    await expect(markdownHighlight).toBeVisible();
    await find.getByRole("button", { name: "Close find" }).click();
    await expect(markdownHighlight).toHaveCount(0);
    await app.page.locator('.ProseMirror[aria-label="notes.md"]').focus();
    await expect
      .poll(
        async () =>
          await app.page.evaluate(() => window.getSelection()?.toString()),
      )
      .toBe("silver marmot");

    await app.page.getByRole("link", { name: "source.ts" }).click();
    await app.page.keyboard.press("ControlOrMeta+f");
    await find.getByRole("textbox", { name: "Find in tab" }).fill("marmot");
    await expect(find).toContainText("1 of 2");
    await app.page.keyboard.press("Escape");

    const session = await app.server.rpc.sessions.create();
    const prompt = app.server.rpc.sessions.prompt({
      ...session,
      text: "The silver marmot is here",
    });
    await llm.respond(m.assistant("I see the silver marmot."));
    await prompt;
    await app.page
      .getByRole("link", { name: "The silver marmot is here" })
      .click();
    await app.page.keyboard.press("ControlOrMeta+f");
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("silver marmot");
    await expect(find).toContainText("1 of 2");
  },
);

e2eTest(
  "searches saved files and sessions and opens a result",
  async ({ app, llm }) => {
    await app.server.rpc.workspace.writeFile({
      path: "notes.txt",
      content: "A silver marmot waits here.",
    });
    const session = await app.server.rpc.sessions.create();
    const prompt = app.server.rpc.sessions.prompt({
      ...session,
      text: "Find the silver marmot",
    });
    await llm.respond(m.assistant("The silver marmot is in the notes."));
    await prompt;

    await app.page
      .getByRole("link", { name: "Find the silver marmot" })
      .click();
    await app.page.keyboard.press("ControlOrMeta+Shift+f");
    const dialog = app.page.getByRole("dialog", { name: "Search workspace" });
    await dialog
      .getByRole("textbox", { name: "Search workspace" })
      .fill("silver marmot");
    const results = dialog.getByRole("list", { name: "Search results" });
    await expect(results).toContainText("notes.txt");
    await expect(results).toContainText("Find the silver marmot");
    await results.getByRole("button").filter({ hasText: "notes.txt" }).click();
    await expect(
      app.page.getByRole("main", { name: "notes.txt" }),
    ).toBeVisible();
    await expect(
      app.page.getByRole("search", { name: "Find in tab" }),
    ).toContainText("1 of 1");

    await app.page.keyboard.press("ControlOrMeta+Shift+f");
    await results
      .getByRole("button")
      .filter({ hasText: "The silver marmot is in the notes." })
      .click();
    await expect(
      app.page.getByRole("main", { name: "Find the silver marmot" }),
    ).toBeVisible();
    await expect(
      app.page.getByRole("search", { name: "Find in tab" }),
    ).toContainText("2 of 2");

    await app.page.keyboard.press("ControlOrMeta+Shift+f");
    await dialog
      .getByRole("textbox", { name: "Search workspace" })
      .fill("no matching phrase");
    await expect(dialog).toContainText("No results for “no matching phrase”.");
  },
);
