$(function () {
    // Add a button at the end (before history) of issue information.
    let target = $("#history");
    if (target.length == 0) {
        return;
    }

    let ins_div = $("<div></div>").insertBefore(target);

    if ($("#branch").length == 0) {
        let btn = '<button type="button" id="branch" disabled="disabled">Create Branch</button>';
        ins_div.append(btn);
    }
    if ($("#release").length == 0) {
        let btn2 = '<button type="button" id="release" disabled="disabled">Release(Merge Branch)</button>';
        ins_div.append(btn2);
    }

    // Create a context for GitLab access.
    GitLabContext = {
        enable: true,
    };
    field = ViewCustomize.context.project.customFields.find((x) => x.name == "GitLab URL");
    if (field == undefined) {
        GitLabContext.enable = false;
    } else {
        GitLabContext.url_path = field.value + "/api/v4/projects/";
    }

    field = ViewCustomize.context.project.customFields.find((x) => x.name == "GitLab Project ID");
    if (field == undefined) {
        GitLabContext.enable = false;
    } else {
        GitLabContext.project_id = field.value;
    }

    field = ViewCustomize.context.project.customFields.find((x) => x.name == "GitLab Token");
    if (field == undefined) {
        GitLabContext.enable = false;
    } else {
        GitLabContext.token = "?private_token=" + field.value;
    }

    // Create branch name with {tracker name}/{issue id}.
    GitLabContext.branch = $("#issue_tracker_id option:selected").text().toLowerCase() + "/" + ViewCustomize.context.issue.id;

    // Get the default branch from GitLab and set it to the GitLab context.
    // The button will be active when all data is gathered.
    let api_url = GitLabContext.url_path + GitLabContext.project_id + "/repository/branches" + GitLabContext.token;
    $.get(api_url, null, null, "json")
        .done(function (res, status, jqXHR) {
            br = res.find((x) => x.default == true);
            if (res == undefined) {
                GitLabContext.enable = false;
            } else {
                GitLabContext.ref = br.name;
            }
            // If there is a shortage of data in GitLabContext, the button will be inactive.
            $("#branch").attr("disabled", !GitLabContext.enable);
            $("#release").attr("disabled", !GitLabContext.enable);
        })
        .fail(function (jqXHR, status, errText) {
            alert(errText + "\n" + jqXHR.responseText);
        });
    ///////////////////////////////////
    // Create Branch Button Handler
    ///////////////////////////////////
    $("#branch").on("click", async function () {
        try {
            // create branch
            await createBranch();
            // create MR
            await createMR(GitLabContext.branch, GitLabContext.ref, $("#issue_subject").val());

            await addNote(2, "Create branch done.");

            location.reload();

            alert("Branch & MR Created!");
        } catch (err) {
            alert(err);
        }
    });
    ///////////////////////////////////
    // Release Button Handler
    ///////////////////////////////////
    $("#release").on("click", async function () {
        try {
            // Get Merge Request
            const mr = await getMR();
            // Merge
            await mergeMR(mr.iid, true, true);

            // create MR for release branch
            let iid1 = await createMR(GitLabContext.ref, "release", "Release " + $("#issue_subject").val());
            await mergeMR(iid1, false, false);

            // create MR for main branch
            let iid2 = await createMR("release", "main", "Merge to main " + $("#issue_subject").val());
            await mergeMR(iid2, false, false);

            await addNote(5, "Release done.");

            location.reload();

            alert("Success");
        } catch (err) {
            alert(err);
        }
    });

    // Create Branch
    async function createBranch() {
        let url = GitLabContext.url_path + GitLabContext.project_id + "/repository/branches" + GitLabContext.token;
        let param = JSON.stringify({
            id: GitLabContext.project_id,
            branch: GitLabContext.branch,
            ref: GitLabContext.ref,
        });

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: param,
        });
        if (res.status != 201) {
            throw new Error("Create Branch Error\n" + res.status + " " + res.statusText);
        }
    }

    // List Merge Request
    async function getMR() {
        let url =
            GitLabContext.url_path +
            GitLabContext.project_id +
            "/merge_requests" +
            GitLabContext.token +
            "&state=opened&source_branch=" +
            GitLabContext.branch +
            "&target_branch=" +
            GitLabContext.ref;
        const res = await fetch(url, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
        if (res.status != 200) {
            throw new Error("List MR Error\n" + res.statusText);
        }
        const json = await res.json();
        if (json.length != 1) {
            throw new Error("List MR Error\n" + json.length + " MR exists");
        }
        return json[0];
    }

    // Merge
    async function mergeMR(mr_iid, remvoe, squash) {
        // Check merge_status.
        // If the merge_status is "checking", wait for "can_be_merged".
        await checkMR(mr_iid);

        // merge
        let url = GitLabContext.url_path + GitLabContext.project_id + "/merge_requests/" + mr_iid + "/merge" + GitLabContext.token;
        const param = JSON.stringify({
            should_remove_source_branch: remvoe,
            squash: squash,
        });
        const res = await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: param,
        });
        if (!res.ok) {
            throw new Error("Merge Response Error\n" + res.status + " " + res.statusText);
        }
        const json = await res.json();
        if (json.state != "merged") {
            throw new Error("Merge State Error\n" + json.state + "\n" + json.title);
        }
    }

    // check MR
    async function checkMR(mr_iid) {
        const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let url = GitLabContext.url_path + GitLabContext.project_id + "/merge_requests/" + mr_iid + GitLabContext.token;
        for (let i = 0; i < 10; i++) {
            const res = await fetch(url, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });
            if (!res.ok) {
                throw new Error("ChecK MR Error\n" + res.status + " " + res.statusText);
            }
            const json = await res.json();
            switch (json.merge_status) {
                case "unchecked":
                case "checking":
                    // continue
                    break;
                case "can_be_merged":
                    return;
                default:
                    throw new Error("MR cannot be merged!\n" + json.merge_status + "\n" + json.detailed_merge_status);
            }
            await _sleep(500);
        }
        throw new Error("check MR Timeout");
    }

    // create MR
    async function createMR(src_branch, target_branch, title) {
        // create MR
        let url = GitLabContext.url_path + GitLabContext.project_id + "/merge_requests" + GitLabContext.token;
        let param = JSON.stringify({
            source_branch: src_branch,
            target_branch: target_branch,
            title: title,
        });
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-Type": "application/json" },
            body: param,
        });
        if (res.status != 201) {
            throw new Error("Create MR Error\n" + title + "\n" + res.status + " " + res.statusText);
        }
        const json = await res.json();
        return json.iid;
    }

    // add note to Redmine ticket
    async function addNote(status_id, note_text) {
        let url = "http://" + location.host + "/issues/" + ViewCustomize.context.issue.id + ".json?key=" + ViewCustomize.context.user.apiKey;
        let param = JSON.stringify({
            issue: {
                status_id: status_id,
                notes: note_text,
            },
        });
        const res = await fetch(url, {
            method: "PUT",
            headers: { "content-Type": "application/json" },
            body: param,
        });
        if (res.status != 204) {
            throw new Error("Redmine ticket add note error\n" + res.status + " " + res.statusText);
        }
    }
});
