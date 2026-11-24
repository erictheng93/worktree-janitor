class WorktreeJanitor < Formula
  desc "Remove git worktrees and local branches whose work is already merged"
  homepage "https://github.com/erictheng93/worktree-janitor"
  url "https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/worktree-janitor-v0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"], ".claude-plugin", ".codex-plugin", ".agents"
    (bin/"worktree-janitor").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("node")}/node" "#{opt_libexec}/scripts/janitor.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      The worktree-janitor command is installed. Homebrew does not change any
      Claude Code or Codex settings; to run the janitor automatically, pick one:

        Claude Code plugin (CLI and desktop app):
          claude plugin marketplace add erictheng93/worktree-janitor@v#{version}
          claude plugin install worktree-janitor@worktree-janitor-marketplace

        Codex plugin (CLI and desktop app), then trust its hooks in /hooks
        (CLI) or Settings > Hooks (app):
          codex plugin marketplace add erictheng93/worktree-janitor --ref v#{version}
          codex plugin add worktree-janitor@worktree-janitor-marketplace

        Codex hooks that run this Homebrew copy:
          #{formula_opt_bin("node")}/node #{opt_libexec}/scripts/install.mjs --codex \\
            --node #{formula_opt_bin("node")}/node
        (remove them again with --codex --uninstall before `brew uninstall`)
    EOS
  end

  test do
    assert_match "remove git worktrees", shell_output("#{bin}/worktree-janitor --help")

    ENV["GIT_AUTHOR_NAME"] = ENV["GIT_COMMITTER_NAME"] = "t"
    ENV["GIT_AUTHOR_EMAIL"] = ENV["GIT_COMMITTER_EMAIL"] = "t@example.invalid"
    system "git", "init", "-q", "--bare", "origin.git"
    system "git", "init", "-q", "repo"
    cd "repo" do
      system "git", "checkout", "-q", "-b", "main"
      (testpath/"repo/a").write "a"
      system "git", "add", "a"
      system "git", "commit", "-q", "-m", "init"
      system "git", "remote", "add", "origin", testpath/"origin.git"
      system "git", "push", "-q", "origin", "main"
      system "git", "remote", "set-head", "origin", "main"
      system "git", "worktree", "add", "-q", "-b", "merged", testpath/"wt"
      (testpath/"wt/b").write "b"
      system "git", "-C", testpath/"wt", "add", "b"
      system "git", "-C", testpath/"wt", "commit", "-q", "-m", "b"
      system "git", "merge", "-q", "--no-ff", "-m", "merge", "merged"
      system "git", "push", "-q", "origin", "main"
      assert_match "would-remove", shell_output(bin/"worktree-janitor")
      assert_path_exists testpath/"wt"
    end
  end
end
