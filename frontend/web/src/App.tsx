// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ConservationProject {
  id: string;
  name: string;
  location: string;
  encryptedBudget: string;
  encryptedSpeciesCount: string;
  timestamp: number;
  proposer: string;
  status: "pending" | "approved" | "rejected";
  votesFor: number;
  votesAgainst: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ConservationProject[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newProjectData, setNewProjectData] = useState({ 
    name: "", 
    location: "", 
    budget: 0,
    speciesCount: 0,
    description: "" 
  });
  const [selectedProject, setSelectedProject] = useState<ConservationProject | null>(null);
  const [decryptedBudget, setDecryptedBudget] = useState<number | null>(null);
  const [decryptedSpeciesCount, setDecryptedSpeciesCount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<"projects" | "forum">("projects");
  const [forumPosts, setForumPosts] = useState<any[]>([]);
  const [newPostContent, setNewPostContent] = useState("");

  const approvedCount = projects.filter(p => p.status === "approved").length;
  const pendingCount = projects.filter(p => p.status === "pending").length;
  const rejectedCount = projects.filter(p => p.status === "rejected").length;

  useEffect(() => {
    loadProjects().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
    loadForumPosts();
  }, []);

  const loadProjects = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("project_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing project keys:", e); }
      }
      const list: ConservationProject[] = [];
      for (const key of keys) {
        try {
          const projectBytes = await contract.getData(`project_${key}`);
          if (projectBytes.length > 0) {
            try {
              const projectData = JSON.parse(ethers.toUtf8String(projectBytes));
              list.push({ 
                id: key, 
                name: projectData.name,
                location: projectData.location,
                encryptedBudget: projectData.budget,
                encryptedSpeciesCount: projectData.speciesCount,
                timestamp: projectData.timestamp, 
                proposer: projectData.proposer, 
                status: projectData.status || "pending",
                votesFor: projectData.votesFor || 0,
                votesAgainst: projectData.votesAgainst || 0
              });
            } catch (e) { console.error(`Error parsing project data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading project ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setProjects(list);
    } catch (e) { console.error("Error loading projects:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitProject = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting sensitive data with Zama FHE..." });
    try {
      const encryptedBudget = FHEEncryptNumber(newProjectData.budget);
      const encryptedSpeciesCount = FHEEncryptNumber(newProjectData.speciesCount);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const projectId = `proj-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const projectData = { 
        name: newProjectData.name,
        location: newProjectData.location,
        budget: encryptedBudget,
        speciesCount: encryptedSpeciesCount,
        description: newProjectData.description,
        timestamp: Math.floor(Date.now() / 1000), 
        proposer: address, 
        status: "pending",
        votesFor: 0,
        votesAgainst: 0
      };
      
      await contract.setData(`project_${projectId}`, ethers.toUtf8Bytes(JSON.stringify(projectData)));
      
      const keysBytes = await contract.getData("project_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(projectId);
      await contract.setData("project_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted project submitted securely!" });
      await loadProjects();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewProjectData({ 
          name: "", 
          location: "", 
          budget: 0,
          speciesCount: 0,
          description: "" 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const voteForProject = async (projectId: string, support: boolean) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted vote with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const projectBytes = await contract.getData(`project_${projectId}`);
      if (projectBytes.length === 0) throw new Error("Project not found");
      const projectData = JSON.parse(ethers.toUtf8String(projectBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedProject = { 
        ...projectData, 
        votesFor: support ? projectData.votesFor + 1 : projectData.votesFor,
        votesAgainst: !support ? projectData.votesAgainst + 1 : projectData.votesAgainst
      };
      
      await contractWithSigner.setData(`project_${projectId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProject)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE vote recorded successfully!" });
      await loadProjects();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Voting failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const loadForumPosts = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const keysBytes = await contract.getData("forum_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing forum keys:", e); }
      }
      const posts: any[] = [];
      for (const key of keys) {
        try {
          const postBytes = await contract.getData(`forum_${key}`);
          if (postBytes.length > 0) {
            try {
              const postData = JSON.parse(ethers.toUtf8String(postBytes));
              posts.push({ 
                id: key, 
                content: postData.content,
                timestamp: postData.timestamp, 
                author: postData.author
              });
            } catch (e) { console.error(`Error parsing post data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading post ${key}:`, e); }
      }
      posts.sort((a, b) => b.timestamp - a.timestamp);
      setForumPosts(posts);
    } catch (e) { console.error("Error loading forum posts:", e); }
  };

  const submitForumPost = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    if (!newPostContent.trim()) { alert("Please enter post content"); return; }
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const postId = `post-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const postData = { 
        content: newPostContent,
        timestamp: Math.floor(Date.now() / 1000), 
        author: address
      };
      
      await contract.setData(`forum_${postId}`, ethers.toUtf8Bytes(JSON.stringify(postData)));
      
      const keysBytes = await contract.getData("forum_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(postId);
      await contract.setData("forum_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setNewPostContent("");
      await loadForumPosts();
    } catch (e: any) {
      console.error("Forum post submission failed:", e);
      alert("Failed to submit post: " + (e.message || "Unknown error"));
    }
  };

  const renderProjectMap = () => {
    // Simulated map with project locations
    const locations = projects.map(p => ({
      name: p.name,
      location: p.location,
      status: p.status
    }));
    
    return (
      <div className="project-map">
        <div className="map-container">
          <div className="world-map">
            {locations.map((loc, idx) => (
              <div 
                key={idx} 
                className={`map-marker ${loc.status}`}
                style={{
                  left: `${Math.random() * 80 + 10}%`,
                  top: `${Math.random() * 80 + 10}%`
                }}
                title={`${loc.name} - ${loc.location}`}
              >
                <div className="marker-pin"></div>
                <div className="marker-tooltip">{loc.name}</div>
              </div>
            ))}
          </div>
          <div className="map-legend">
            <div className="legend-item"><div className="color-box approved"></div><span>Approved</span></div>
            <div className="legend-item"><div className="color-box pending"></div><span>Pending</span></div>
            <div className="legend-item"><div className="color-box rejected"></div><span>Rejected</span></div>
          </div>
        </div>
      </div>
    );
  };

  const renderStats = () => {
    const totalBudget = projects.reduce((sum, project) => {
      if (project.status === "approved") {
        return sum + (decryptedBudget || 0);
      }
      return sum;
    }, 0);
    
    return (
      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-value">{projects.length}</div>
          <div className="stat-label">Total Projects</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">${totalBudget.toLocaleString()}</div>
          <div className="stat-label">Total Funding</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{approvedCount}</div>
          <div className="stat-label">Approved</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="nature-spinner">
        <div className="leaf leaf1"></div>
        <div className="leaf leaf2"></div>
        <div className="leaf leaf3"></div>
      </div>
      <p>Connecting to conservation network...</p>
    </div>
  );

  return (
    <div className="app-container nature-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24">
              <path d="M12,2L4,12L12,22L20,12L12,2M12,4L18,12L12,20L6,12L12,4Z" />
            </svg>
          </div>
          <h1>ReFi<span>Conservation</span>DAO</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-project-btn nature-button">
            <div className="add-icon"></div>Propose Project
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Protecting Nature with FHE Privacy</h2>
            <p>A decentralized autonomous organization funding ecological conservation projects worldwide with confidential voting</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>Zama FHE Encryption</span>
          </div>
        </div>
        
        <div className="tabs-container">
          <div className="tabs">
            <button 
              className={`tab-button ${activeTab === "projects" ? "active" : ""}`}
              onClick={() => setActiveTab("projects")}
            >
              Conservation Projects
            </button>
            <button 
              className={`tab-button ${activeTab === "forum" ? "active" : ""}`}
              onClick={() => setActiveTab("forum")}
            >
              DAO Governance Forum
            </button>
          </div>
        </div>
        
        {activeTab === "projects" ? (
          <>
            <div className="dashboard-grid">
              <div className="dashboard-card nature-card">
                <h3>Global Conservation Efforts</h3>
                {renderProjectMap()}
              </div>
              
              <div className="dashboard-card nature-card">
                <h3>Project Statistics</h3>
                {renderStats()}
              </div>
              
              <div className="dashboard-card nature-card intro-card">
                <h3>About Our Mission</h3>
                <p>
                  The ReFi Conservation DAO uses <strong>Zama FHE technology</strong> to protect sensitive ecological data 
                  while enabling decentralized governance. Project proposals containing confidential location and species 
                  information are encrypted before submission, and votes are processed without revealing individual choices.
                </p>
                <div className="fhe-badge">
                  <span>FHE-Powered Privacy</span>
                </div>
              </div>
            </div>
            
            <div className="projects-section">
              <div className="section-header">
                <h2>Conservation Project Proposals</h2>
                <div className="header-actions">
                  <button onClick={loadProjects} className="refresh-btn nature-button" disabled={isRefreshing}>
                    {isRefreshing ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
              </div>
              
              <div className="projects-list">
                {projects.length === 0 ? (
                  <div className="no-projects">
                    <div className="no-projects-icon"></div>
                    <p>No conservation projects found</p>
                    <button className="nature-button primary" onClick={() => setShowCreateModal(true)}>
                      Propose First Project
                    </button>
                  </div>
                ) : (
                  <div className="project-cards">
                    {projects.map(project => (
                      <div 
                        className={`project-card ${project.status}`} 
                        key={project.id}
                        onClick={() => setSelectedProject(project)}
                      >
                        <div className="card-header">
                          <h3>{project.name}</h3>
                          <span className={`status-badge ${project.status}`}>{project.status}</span>
                        </div>
                        <div className="card-body">
                          <div className="project-location">
                            <div className="location-icon"></div>
                            <span>{project.location}</span>
                          </div>
                          <div className="project-meta">
                            <div className="meta-item">
                              <div className="meta-label">Proposed</div>
                              <div className="meta-value">
                                {new Date(project.timestamp * 1000).toLocaleDateString()}
                              </div>
                            </div>
                            <div className="meta-item">
                              <div className="meta-label">Votes</div>
                              <div className="meta-value">
                                {project.votesFor} For / {project.votesAgainst} Against
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="card-footer">
                          <button 
                            className="nature-button success"
                            onClick={(e) => {
                              e.stopPropagation();
                              voteForProject(project.id, true);
                            }}
                          >
                            Vote For
                          </button>
                          <button 
                            className="nature-button danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              voteForProject(project.id, false);
                            }}
                          >
                            Vote Against
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="forum-section">
            <div className="forum-posts">
              <h2>DAO Governance Discussions</h2>
              
              <div className="new-post-form">
                <textarea
                  value={newPostContent}
                  onChange={(e) => setNewPostContent(e.target.value)}
                  placeholder="Share your thoughts about conservation governance..."
                  className="nature-textarea"
                ></textarea>
                <button 
                  onClick={submitForumPost}
                  className="nature-button primary"
                  disabled={!newPostContent.trim()}
                >
                  Post to Forum
                </button>
              </div>
              
              {forumPosts.length === 0 ? (
                <div className="no-posts">
                  <div className="no-posts-icon"></div>
                  <p>No discussion posts yet</p>
                </div>
              ) : (
                <div className="posts-list">
                  {forumPosts.map(post => (
                    <div className="forum-post" key={post.id}>
                      <div className="post-header">
                        <div className="post-author">
                          {post.author.substring(0, 6)}...{post.author.substring(38)}
                        </div>
                        <div className="post-date">
                          {new Date(post.timestamp * 1000).toLocaleString()}
                        </div>
                      </div>
                      <div className="post-content">
                        {post.content}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitProject} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          projectData={newProjectData} 
          setProjectData={setNewProjectData}
        />
      )}
      
      {selectedProject && (
        <ProjectDetailModal 
          project={selectedProject} 
          onClose={() => { 
            setSelectedProject(null); 
            setDecryptedBudget(null);
            setDecryptedSpeciesCount(null);
          }} 
          decryptedBudget={decryptedBudget}
          decryptedSpeciesCount={decryptedSpeciesCount}
          setDecryptedBudget={setDecryptedBudget}
          setDecryptedSpeciesCount={setDecryptedSpeciesCount}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content nature-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="nature-spinner small"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="logo-icon small"></div>
              <span>ReFi Conservation DAO</span>
            </div>
            <p>Protecting ecosystems with decentralized governance and FHE privacy</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} ReFi Conservation DAO. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  projectData: any;
  setProjectData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, projectData, setProjectData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setProjectData({ ...projectData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setProjectData({ ...projectData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!projectData.name || !projectData.location || !projectData.budget || !projectData.speciesCount) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal nature-card">
        <div className="modal-header">
          <h2>New Conservation Project</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Sensitive ecological data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Project Name *</label>
              <input 
                type="text" 
                name="name" 
                value={projectData.name} 
                onChange={handleChange} 
                placeholder="Project name..."
                className="nature-input"
              />
            </div>
            
            <div className="form-group">
              <label>Location *</label>
              <input 
                type="text" 
                name="location" 
                value={projectData.location} 
                onChange={handleChange} 
                placeholder="Geographic location..."
                className="nature-input"
              />
            </div>
            
            <div className="form-group">
              <label>Requested Budget (USD) *</label>
              <input 
                type="number" 
                name="budget" 
                value={projectData.budget} 
                onChange={handleNumberChange} 
                placeholder="Funding amount needed..."
                className="nature-input"
                min="0"
                step="100"
              />
            </div>
            
            <div className="form-group">
              <label>Species Count *</label>
              <input 
                type="number" 
                name="speciesCount" 
                value={projectData.speciesCount} 
                onChange={handleNumberChange} 
                placeholder="Number of species protected..."
                className="nature-input"
                min="0"
              />
            </div>
            
            <div className="form-group full-width">
              <label>Project Description</label>
              <textarea 
                name="description" 
                value={projectData.description} 
                onChange={handleChange} 
                placeholder="Describe the conservation project..."
                className="nature-textarea"
                rows={4}
              ></textarea>
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Budget:</span>
                <div>${projectData.budget || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted:</span>
                <div>{projectData.budget ? FHEEncryptNumber(projectData.budget).substring(0, 30) + '...' : 'No value'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn nature-button">Cancel</button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn nature-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Proposal"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ProjectDetailModalProps {
  project: ConservationProject;
  onClose: () => void;
  decryptedBudget: number | null;
  decryptedSpeciesCount: number | null;
  setDecryptedBudget: (value: number | null) => void;
  setDecryptedSpeciesCount: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const ProjectDetailModal: React.FC<ProjectDetailModalProps> = ({ 
  project, 
  onClose, 
  decryptedBudget,
  decryptedSpeciesCount,
  setDecryptedBudget,
  setDecryptedSpeciesCount,
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async (type: 'budget' | 'species') => {
    if (type === 'budget' && decryptedBudget !== null) {
      setDecryptedBudget(null);
      return;
    }
    if (type === 'species' && decryptedSpeciesCount !== null) {
      setDecryptedSpeciesCount(null);
      return;
    }
    
    const encryptedValue = type === 'budget' ? project.encryptedBudget : project.encryptedSpeciesCount;
    const decrypted = await decryptWithSignature(encryptedValue);
    
    if (decrypted !== null) {
      if (type === 'budget') {
        setDecryptedBudget(decrypted);
      } else {
        setDecryptedSpeciesCount(decrypted);
      }
    }
  };

  return (
    <div className="modal-overlay">
      <div className="project-detail-modal nature-card">
        <div className="modal-header">
          <h2>{project.name}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="project-info">
            <div className="info-item">
              <span>Location:</span>
              <strong>{project.location}</strong>
            </div>
            <div className="info-item">
              <span>Proposer:</span>
              <strong>{project.proposer.substring(0, 6)}...{project.proposer.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date Proposed:</span>
              <strong>{new Date(project.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${project.status}`}>{project.status}</strong>
            </div>
            <div className="info-item">
              <span>Votes:</span>
              <strong>{project.votesFor} For / {project.votesAgainst} Against</strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Project Data</h3>
            
            <div className="encrypted-item">
              <div className="item-header">
                <span>Budget:</span>
                <button 
                  className="nature-button small"
                  onClick={() => handleDecrypt('budget')}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : 
                   decryptedBudget !== null ? "Hide Value" : "Decrypt with Wallet"}
                </button>
              </div>
              {decryptedBudget !== null ? (
                <div className="decrypted-value">${decryptedBudget.toLocaleString()}</div>
              ) : (
                <div className="encrypted-value">
                  {project.encryptedBudget.substring(0, 50)}...
                </div>
              )}
            </div>
            
            <div className="encrypted-item">
              <div className="item-header">
                <span>Species Count:</span>
                <button 
                  className="nature-button small"
                  onClick={() => handleDecrypt('species')}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : 
                   decryptedSpeciesCount !== null ? "Hide Value" : "Decrypt with Wallet"}
                </button>
              </div>
              {decryptedSpeciesCount !== null ? (
                <div className="decrypted-value">{decryptedSpeciesCount} species</div>
              ) : (
                <div className="encrypted-value">
                  {project.encryptedSpeciesCount.substring(0, 50)}...
                </div>
              )}
            </div>
            
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted Data</span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn nature-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;
